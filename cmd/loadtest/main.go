// Command loadtest simulates players against a running server
// (target: 300 players × 5 games, p95 < 200 ms). Each player polls the leaderboard
// every 10 s like the real page, plays honest rounds (the server validates
// them for real), and merges after the first one.
//
//	go run ./cmd/loadtest -url http://localhost:8080 -players 300 -games 5 -ramp 30m
//
// The server should run with TRUST_PROXY=1 so -ips spreads players over
// several fake client IPs (otherwise the per-IP backstop sees one address).
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"fixthebuild/internal/game"
)

var (
	base    = flag.String("url", "http://localhost:8080", "server base URL")
	players = flag.Int("players", 300, "number of players")
	games   = flag.Int("games", 5, "games per player")
	ramp    = flag.Duration("ramp", 30*time.Minute, "spread player arrivals over this long")
	round   = flag.Duration("round", 23*time.Second, "time from start to finish (server needs ≥19 s)")
	gap     = flag.Duration("gap", 20*time.Second, "max pause between a player's games (min 5 s)")
	ips     = flag.Int("ips", 20, "fake client IPs (X-Forwarded-For)")
	p95Max  = flag.Duration("p95", 200*time.Millisecond, "fail if any endpoint's p95 exceeds this")
	tag     = flag.String("tag", "load", "handle prefix (keep runs on one DB distinct)")
)

type stat struct {
	mu   sync.Mutex
	lat  map[string][]time.Duration
	errs map[string]int
}

var st = stat{lat: map[string][]time.Duration{}, errs: map[string]int{}}

func (s *stat) add(ep string, d time.Duration, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lat[ep] = append(s.lat[ep], d)
	if !ok {
		s.errs[ep]++
	}
}

var client = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{MaxIdleConnsPerHost: 512}}

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

type player struct {
	n      int
	device string
	ip     string
}

func (p *player) call(ep, method, path string, body any, out any) int {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, *base+path, r)
	req.Header.Set("X-Device-Token", p.device)
	req.Header.Set("X-Forwarded-For", p.ip)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	t := time.Now()
	res, err := client.Do(req)
	d := time.Since(t)
	if err != nil {
		st.add(ep, d, false)
		return 0
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	} else {
		io.Copy(io.Discard, res.Body)
	}
	st.add(ep, d, res.StatusCode < 300)
	return res.StatusCode
}

// honest builds a valid result for this seed: n bugs at ×1, a few misses.
func honest(seed uint32) game.Result {
	sup := game.SupplyOf(game.BuildSchedule(seed, &game.Default))
	n := min(5+mrand.IntN(20), sup.Total)
	r := game.Result{Bugs: n, BugsX1: n, MaxCombo: min(n, 4), Taps: n + mrand.IntN(15)}
	r.Score = game.ScoreOf(r, &game.Default)
	return r
}

func (p *player) run(wg *sync.WaitGroup) {
	defer wg.Done()
	p.call("GET /api/config", "GET", "/api/config", nil, nil)
	p.call("GET /api/me", "GET", "/api/me", nil, nil)
	stop := make(chan struct{})
	go func() { // the page polls every 10 s while open
		t := time.NewTicker(10 * time.Second)
		defer t.Stop()
		for {
			p.call("GET /api/leaderboard", "GET", "/api/leaderboard?limit=50", nil, nil)
			select {
			case <-stop:
				return
			case <-t.C:
			}
		}
	}()
	defer close(stop)

	for g := 0; g < *games; g++ {
		var run struct {
			RunID string `json:"run_id"`
			Seed  uint32 `json:"seed"`
		}
		if code := p.call("POST /api/runs", "POST", "/api/runs", nil, &run); code != 201 {
			time.Sleep(5 * time.Second) // back off like a person tapping Retry
			continue
		}
		time.Sleep(*round)
		p.call("POST /api/runs/{id}/finish", "POST", "/api/runs/"+run.RunID+"/finish", honest(run.Seed), nil)
		if g == 0 {
			p.call("POST /api/merge", "POST", "/api/merge", map[string]any{
				"name": fmt.Sprintf("%s %d", *tag, p.n), "handle": fmt.Sprintf("%s_%d", *tag, p.n), "handle_type": "x",
				"commit_message": "perf: survived the load test", "consent": true, "run_id": run.RunID,
			}, nil)
		}
		p.call("GET /api/me", "GET", "/api/me", nil, nil)
		time.Sleep(5*time.Second + time.Duration(mrand.Int64N(int64(max(*gap-5*time.Second, 1)))))
	}
}

func pct(d []time.Duration, q float64) time.Duration { return d[int(q*float64(len(d)-1))] }

func main() {
	flag.Parse()
	log.Printf("%d players × %d games against %s, arrivals over %s", *players, *games, *base, *ramp)
	for i := 0; ; i++ { // wait for the server to be up
		if res, err := client.Get(*base + "/healthz"); err == nil && res.StatusCode == 200 {
			res.Body.Close()
			break
		}
		if i == 60 {
			log.Fatal("server not healthy after 30 s")
		}
		time.Sleep(500 * time.Millisecond)
	}
	start := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < *players; i++ {
		p := &player{n: i, device: uuid(), ip: fmt.Sprintf("10.0.%d.%d", (i%*ips)/250, (i%*ips)%250+1)}
		wg.Add(1)
		go p.run(&wg)
		if *players > 1 {
			time.Sleep(*ramp / time.Duration(*players))
		}
	}
	// Board screen polling /api/stats every 5 s for the whole test.
	boardStop := make(chan struct{})
	go func() {
		p := &player{device: uuid(), ip: "10.9.9.9"}
		for {
			p.call("GET /api/stats", "GET", "/api/stats", nil, nil)
			select {
			case <-boardStop:
				return
			case <-time.After(5 * time.Second):
			}
		}
	}()
	wg.Wait()
	close(boardStop)

	fmt.Printf("\ndone in %s\n\n%-28s %7s %6s %8s %8s %8s %8s\n", time.Since(start).Round(time.Second), "endpoint", "reqs", "errs", "p50", "p95", "p99", "max")
	eps := make([]string, 0, len(st.lat))
	for k := range st.lat {
		eps = append(eps, k)
	}
	sort.Strings(eps)
	fail := false
	for _, ep := range eps {
		d := st.lat[ep]
		sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
		p95 := pct(d, .95)
		mark := ""
		if p95 > *p95Max {
			mark, fail = "  ✗ over budget", true
		}
		fmt.Printf("%-28s %7d %6d %8s %8s %8s %8s%s\n", ep, len(d), st.errs[ep],
			pct(d, .5).Round(10*time.Microsecond), p95.Round(10*time.Microsecond), pct(d, .99).Round(10*time.Microsecond), d[len(d)-1].Round(10*time.Microsecond), mark)
		if st.errs[ep] > 0 && !strings.Contains(ep, "merge") {
			fail = true
		}
	}
	if fail {
		fmt.Println("\nFAIL")
		os.Exit(1)
	}
	fmt.Printf("\nPASS: every endpoint p95 < %s, no errors\n", *p95Max)
}
