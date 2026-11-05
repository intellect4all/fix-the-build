package game

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

type fixture struct {
	Rng    []float64 `json:"rng"`
	First8 []Spawn   `json:"first8"`
	Counts map[string]struct {
		N, Bug, Golden, Feature, Armored int
	} `json:"counts"`
	Runs []struct {
		Seed uint32 `json:"seed"`
		Result
	} `json:"runs"`
}

func load(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile("testdata/fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestMulberry32MatchesTS(t *testing.T) {
	f := load(t)
	r := Mulberry32(42)
	for i, want := range f.Rng {
		if got := r(); got != want {
			t.Fatalf("draw %d: got %v want %v", i, got, want)
		}
	}
}

func TestScheduleMatchesTS(t *testing.T) {
	f := load(t)
	got := BuildSchedule(20261105, &Default)[:8]
	for i, w := range f.First8 {
		if got[i] != w {
			t.Fatalf("spawn %d:\n got %+v\nwant %+v", i, got[i], w)
		}
	}
	for k, w := range f.Counts {
		seed, _ := strconv.ParseUint(k, 10, 32)
		s := BuildSchedule(uint32(seed), &Default)
		var g struct{ N, Bug, Golden, Feature, Armored int }
		g.N = len(s)
		for _, x := range s {
			switch x.Kind {
			case Bug:
				g.Bug++
			case Golden:
				g.Golden++
			case Feature:
				g.Feature++
			}
			if x.Armored {
				g.Armored++
			}
		}
		if g != w {
			t.Fatalf("seed %s: got %+v want %+v", k, g, w)
		}
	}
}

func TestHonestRunsNeverFlagged(t *testing.T) {
	f := load(t)
	for i, r := range f.Runs {
		if why := Check(r.Seed, r.Result, &Default); why != "" {
			t.Fatalf("run %d (seed %d) flagged: %s %+v", i, r.Seed, why, r.Result)
		}
	}
}

func TestScoreOf(t *testing.T) {
	cases := []struct {
		r    Result
		want int
	}{
		{Result{BugsX1: 4}, 4},
		{Result{BugsX1: 4, BugsX2: 5, BugsX3: 3}, 4 + 10 + 9},
		{Result{BugsX1: 4, BugsX2: 5, BugsX3: 11, Golden: 2, FeaturesHit: 6}, 4 + 10 + 33 + 10 - 18},
		{Result{BugsX1: 1, FeaturesHit: 2}, 0}, // never below zero
	}
	for _, c := range cases {
		if got := ScoreOf(c.r, &Default); got != c.want {
			t.Errorf("%+v: got %d want %d", c.r, got, c.want)
		}
	}
}

func TestCheckRejectsForgeries(t *testing.T) {
	seed := uint32(20261105)
	ok := Result{Bugs: 12, BugsX1: 4, BugsX2: 5, BugsX3: 3, Golden: 1, MaxCombo: 13, Taps: 20, Score: 4 + 10 + 9 + 5}
	if why := Check(seed, ok, &Default); why != "" {
		t.Fatalf("baseline flagged: %s", why)
	}
	bad := map[string]func(r *Result){
		"wrong score":    func(r *Result) { r.Score++ },
		"tiers mismatch": func(r *Result) { r.Bugs++ },
		"too many taps":  func(r *Result) { r.Taps = 401 },
		"taps < hits":    func(r *Result) { r.Taps = 5 },
		"combo > hits":   func(r *Result) { r.MaxCombo = 99 },
		"x3 without 10":  func(r *Result) { r.MaxCombo = 9 },
		"x2 without 5":   func(r *Result) { r.BugsX3 = 0; r.Bugs = 9; r.MaxCombo = 4; r.Score = 4 + 10 + 5 },
		"golden supply":  func(r *Result) { r.Golden = 3; r.Score += 10; r.MaxCombo = 13 },
		"feature supply": func(r *Result) { r.FeaturesHit = 99; r.Score = 0; r.Taps = 200 },
		"total supply":   func(r *Result) { r.BugsX3 = 80; r.Bugs = 89; r.Score = 4 + 10 + 240 + 5; r.Taps = 200; r.MaxCombo = 90 },
		"negative":       func(r *Result) { r.FeaturesHit = -1 },
		"hand-made 9999": func(r *Result) { r.Score = 9999 },
	}
	for name, mut := range bad {
		r := ok
		mut(&r)
		if Check(seed, r, &Default) == "" {
			t.Errorf("%s: not flagged %+v", name, r)
		}
	}
}
