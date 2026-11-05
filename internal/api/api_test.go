package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"fixthebuild/internal/game"
	"fixthebuild/internal/store"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

type env struct {
	t   *testing.T
	srv *Server
	clk *clock
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	clk := &clock{t: time.Date(2026, 11, 21, 12, 0, 0, 0, time.UTC)}
	srv := New(st, Options{Public: PublicConfig{OrganiserName: "Jemeel", PassThreshold: 15}, Now: clk.now})
	return &env{t: t, srv: srv, clk: clk}
}

func dev(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

func (e *env) do(device, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	if device != "" {
		req.Header.Set("X-Device-Token", device)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// honest plays a plausible round for the run's seed scoring roughly `bugs` points at ×1.
func honest(seed uint32, bugs int) game.Result {
	r := game.Result{Bugs: bugs, BugsX1: bugs, MaxCombo: min(bugs, 4), Taps: bugs + 3}
	r.Score = game.ScoreOf(r, &game.Default)
	if game.Check(seed, r, &game.Default) != "" {
		panic(game.Check(seed, r, &game.Default))
	}
	return r
}

// play starts and finishes a run (25 s later) and returns the finish response.
func (e *env) play(device string, bugs int) map[string]any {
	e.t.Helper()
	code, run := e.do(device, "POST", "/api/runs", nil)
	if code != 201 {
		e.t.Fatalf("start: %d %v", code, run)
	}
	e.clk.add(25 * time.Second)
	seed := uint32(run["seed"].(float64))
	code, out := e.do(device, "POST", "/api/runs/"+run["run_id"].(string)+"/finish", honest(seed, bugs))
	if code != 200 {
		e.t.Fatalf("finish: %d %v", code, out)
	}
	out["run_id"] = run["run_id"]
	return out
}

func (e *env) merge(device, name, handle, runID string) (int, map[string]any) {
	return e.do(device, "POST", "/api/merge", map[string]any{
		"name": name, "handle": handle, "handle_type": "x", "commit_message": "fix: it works on my machine", "consent": true, "run_id": runID,
	})
}

func (e *env) board(device string) []map[string]any {
	e.t.Helper()
	e.clk.add(3 * time.Second) // past the 2 s cache
	_, lb := e.do(device, "GET", "/api/leaderboard", nil)
	var rows []map[string]any
	for _, r := range lb["rows"].([]any) {
		rows = append(rows, r.(map[string]any))
	}
	return rows
}

func TestFullFlow(t *testing.T) {
	e := newEnv(t)
	a, b := dev(1), dev(2)

	// Two rounds before merging: both attach on merge, best is the max.
	r1 := e.play(a, 12)
	if r1["is_new_best"] != true || r1["rank"] != nil {
		t.Fatalf("first run: %v", r1)
	}
	e.clk.add(6 * time.Second)
	r2 := e.play(a, 20)
	_, me := e.do(a, "GET", "/api/me", nil)
	if me["merged"] != false || me["best"].(float64) != 20 || me["pushes"].(float64) != 2 {
		t.Fatalf("unmerged me: %v", me)
	}
	code, m := e.merge(a, "Tunde", "@Tunde_Dev", r2["run_id"].(string))
	if code != 201 || m["merged"] != true || m["handle"] != "tunde_dev" || m["best"].(float64) != 20 || m["pushes"].(float64) != 2 || m["rank"].(float64) != 1 {
		t.Fatalf("merge: %d %v", code, m)
	}
	if h := m["hash"].(string); len(h) != 7 {
		t.Fatalf("hash %q", h)
	}

	// Row visible straight away (cache invalidated on merge).
	_, lb := e.do(a, "GET", "/api/leaderboard", nil)
	if rows := lb["rows"].([]any); len(rows) != 1 || rows[0].(map[string]any)["me"] != true {
		t.Fatalf("board after merge: %v", lb)
	}

	// Player B: 30 beats A.
	rb := e.play(b, 30)
	if code, m := e.merge(b, "Aisha", "https://x.com/aisha_ui", rb["run_id"].(string)); code != 201 || m["rank"].(float64) != 1 {
		t.Fatalf("merge b: %d %v", code, m)
	}

	// A plays worse: best unchanged, pushes up, not new best.
	e.clk.add(6 * time.Second)
	worse := e.play(a, 5)
	if worse["is_new_best"] != false || worse["best"].(float64) != 20 || worse["rank"].(float64) != 2 {
		t.Fatalf("worse: %v", worse)
	}
	// A plays better: new best, passes Aisha.
	e.clk.add(6 * time.Second)
	better := e.play(a, 35)
	if better["is_new_best"] != true || better["best"].(float64) != 35 || better["rank"].(float64) != 1 || better["passed_player"] != "@aisha_ui" {
		t.Fatalf("better: %v", better)
	}

	rows := e.board(b)
	if rows[0]["handle"] != "tunde_dev" || rows[0]["pushes"].(float64) != 4 || rows[1]["handle"] != "aisha_ui" || rows[1]["me"] != true {
		t.Fatalf("order: %v", rows)
	}
}

func TestTieGoesToWhoGotThereFirst(t *testing.T) {
	e := newEnv(t)
	a, b := dev(1), dev(2)
	ra := e.play(a, 10)
	rb := e.play(b, 10)
	e.merge(b, "Bee", "bee", rb["run_id"].(string)) // b merges first…
	e.merge(a, "Ay", "ay", ra["run_id"].(string))
	rows := e.board(a)
	if rows[0]["handle"] != "ay" { // …but a reached 10 first
		t.Fatalf("tie order: %v", rows)
	}
}

func TestForgedScoresNeverCount(t *testing.T) {
	e := newEnv(t)
	a := dev(1)
	r := e.play(a, 10)
	e.merge(a, "Tunde", "tunde", r["run_id"].(string))

	// Hand-made run id.
	if code, _ := e.do(a, "POST", "/api/runs/deadbeef/finish", honest(1, 10)); code != 404 {
		t.Fatalf("unknown run: %d", code)
	}
	// Someone else's run.
	e.clk.add(6 * time.Second)
	_, run := e.do(dev(9), "POST", "/api/runs", nil)
	e.clk.add(25 * time.Second)
	if code, _ := e.do(a, "POST", "/api/runs/"+run["run_id"].(string)+"/finish", honest(1, 10)); code != 404 {
		t.Fatalf("other device's run: %d", code)
	}

	forge := func(name string, wait time.Duration, res func(seed uint32) game.Result) {
		e.clk.add(6 * time.Second)
		_, run := e.do(a, "POST", "/api/runs", nil)
		e.clk.add(wait)
		code, out := e.do(a, "POST", "/api/runs/"+run["run_id"].(string)+"/finish", res(uint32(run["seed"].(float64))))
		if code != 200 { // looks normal…
			t.Fatalf("%s: %d %v", name, code, out)
		}
		if rows := e.board(a); rows[0]["best"].(float64) != 10 { // …but doesn't count
			t.Fatalf("%s counted: %v", name, rows)
		}
	}
	forge("score mismatch", 25*time.Second, func(s uint32) game.Result { r := honest(s, 10); r.Score = 999; return r })
	forge("too fast", 5*time.Second, func(s uint32) game.Result { return honest(s, 40) })
	forge("too slow", 11*time.Minute, func(s uint32) game.Result { return honest(s, 40) })
	forge("too many taps", 25*time.Second, func(s uint32) game.Result { r := honest(s, 40); r.Taps = 500; return r })
	forge("supply", 25*time.Second, func(s uint32) game.Result {
		r := game.Result{Bugs: 150, BugsX3: 150, MaxCombo: 150, Taps: 199}
		r.Score = game.ScoreOf(r, &game.Default)
		return r
	})

	// Finishing twice doesn't overwrite.
	e.clk.add(6 * time.Second)
	_, run = e.do(a, "POST", "/api/runs", nil)
	e.clk.add(25 * time.Second)
	id, seed := run["run_id"].(string), uint32(run["seed"].(float64))
	e.do(a, "POST", "/api/runs/"+id+"/finish", honest(seed, 3))
	_, again := e.do(a, "POST", "/api/runs/"+id+"/finish", honest(seed, 40))
	if again["score"].(float64) != 3 {
		t.Fatalf("second finish: %v", again)
	}
	if rows := e.board(a); rows[0]["best"].(float64) != 10 {
		t.Fatalf("double finish counted: %v", rows)
	}
}

func TestMergeRules(t *testing.T) {
	e := newEnv(t)
	a, b := dev(1), dev(2)
	ra := e.play(a, 10)
	rb := e.play(b, 10)

	bad := []map[string]any{
		{"name": "J", "handle": "ok", "commit_message": "m", "consent": true},
		{"name": "Jo", "handle": "has space", "commit_message": "m", "consent": true},
		{"name": "Jo", "handle": "ok", "commit_message": "  ", "consent": true},
		{"name": "Jo", "handle": "ok", "commit_message": string(bytes.Repeat([]byte("🐛"), 73)), "consent": true},
		{"name": "Jo", "handle": "ok", "commit_message": "m", "consent": false},
		{"name": "Jo", "handle": "ok", "commit_message": "m", "consent": true, "run_id": "nope"},
	}
	for i, body := range bad {
		if _, ok := body["run_id"]; !ok {
			body["run_id"] = ra["run_id"]
		}
		if code, out := e.do(a, "POST", "/api/merge", body); code != 400 {
			t.Errorf("bad merge %d: %d %v", i, code, out)
		}
	}
	// 72 emoji is fine (runes, not bytes).
	ok := map[string]any{"name": "Jo", "handle": "jo", "commit_message": string(bytes.Repeat([]byte("🐛"), 72)), "consent": true, "run_id": ra["run_id"]}
	if code, out := e.do(a, "POST", "/api/merge", ok); code != 201 {
		t.Fatalf("emoji merge: %d %v", code, out)
	}
	if code, _ := e.do(a, "POST", "/api/merge", ok); code != 409 {
		t.Fatalf("second merge from same device: %d", code)
	}
	code, out := e.merge(b, "Imposter", "@JO", rb["run_id"].(string))
	if code != 409 || out["error"].(map[string]any)["code"] != "handle_taken" {
		t.Fatalf("duplicate handle: %d %v", code, out)
	}
	// A run from another device can't be used.
	if code, _ := e.merge(b, "Bee", "bee", ra["run_id"].(string)); code != 400 {
		t.Fatalf("foreign run: %d", code)
	}
}

func TestRateLimits(t *testing.T) {
	e := newEnv(t)
	a := dev(1)
	if code, _ := e.do(a, "POST", "/api/runs", nil); code != 201 {
		t.Fatal(code)
	}
	if code, out := e.do(a, "POST", "/api/runs", nil); code != 429 || out["error"].(map[string]any)["code"] != "rate_limited" {
		t.Fatalf("rapid start: %d", code)
	}
	if code, _ := e.do(dev(2), "POST", "/api/runs", nil); code != 201 {
		t.Fatalf("other device blocked: %d", code)
	}
	e.clk.add(5 * time.Second)
	if code, _ := e.do(a, "POST", "/api/runs", nil); code != 201 {
		t.Fatalf("after 5 s: %d", code)
	}
	valid := map[string]any{"name": "Jo", "handle": "jo", "commit_message": "m", "consent": true, "run_id": "x"}
	for i := 0; i < 5; i++ {
		e.do(a, "POST", "/api/merge", valid)
	}
	if code, _ := e.do(a, "POST", "/api/merge", valid); code != 429 {
		t.Fatalf("merge limit: %d", code)
	}
	if code, _ := e.do("", "GET", "/api/me", nil); code != 400 {
		t.Fatalf("missing device: %d", code)
	}
	if code, _ := e.do("not-a-uuid", "GET", "/api/me", nil); code != 400 {
		t.Fatalf("bad device: %d", code)
	}
}

func TestEditAndDelete(t *testing.T) {
	e := newEnv(t)
	a, b := dev(1), dev(2)
	r := e.play(a, 10)
	e.merge(a, "Tunde", "tunde", r["run_id"].(string))
	e.clk.add(6 * time.Second)
	e.play(a, 12)
	rb := e.play(b, 8)
	e.merge(b, "Bee", "bee", rb["run_id"].(string))

	code, m := e.do(a, "PATCH", "/api/me", map[string]any{"commit_message": "  feat:\nnew\tline  "})
	if code != 200 || m["commit_message"] != "feat: new line" {
		t.Fatalf("patch: %d %v", code, m)
	}
	if code, _ := e.do(a, "DELETE", "/api/me", nil); code != 204 {
		t.Fatal(code)
	}
	_, me := e.do(a, "GET", "/api/me", nil)
	if me["merged"] != false || me["best"] != nil || me["pushes"].(float64) != 0 {
		t.Fatalf("after delete: %v", me)
	}
	if rows := e.board(b); len(rows) != 1 || rows[0]["handle"] != "bee" {
		t.Fatalf("board after delete: %v", rows)
	}
	var n int
	e.srv.st.DB().QueryRow(`SELECT COUNT(*) FROM runs WHERE device_token = ?`, a).Scan(&n)
	if n != 0 {
		t.Fatalf("%d runs left", n)
	}
	// Handle is free again.
	r = e.play(a, 3)
	if code, _ := e.merge(a, "Tunde", "tunde", r["run_id"].(string)); code != 201 {
		t.Fatalf("re-merge: %d", code)
	}
}

func TestLeaderboardPinsMe(t *testing.T) {
	e := newEnv(t)
	for i := 1; i <= 4; i++ {
		r := e.play(dev(i), 10+i)
		e.merge(dev(i), fmt.Sprintf("P%d", i), fmt.Sprintf("p%d", i), r["run_id"].(string))
	}
	e.clk.add(3 * time.Second)
	_, lb := e.do(dev(1), "GET", "/api/leaderboard?limit=2", nil)
	me := lb["me"].(map[string]any)
	if len(lb["rows"].([]any)) != 2 || me["rank"].(float64) != 4 || me["me"] != true || lb["total_players"].(float64) != 4 {
		t.Fatalf("pinned: %v", lb)
	}
	_, st := e.do("", "GET", "/api/stats", nil)
	if st["total_players"].(float64) != 4 || st["total_pushes"].(float64) != 4 || st["top_contributor"].(map[string]any)["handle"] != "p4" {
		t.Fatalf("stats: %v", st)
	}
}
