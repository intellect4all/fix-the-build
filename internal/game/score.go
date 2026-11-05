package game

import "fmt"

// Result is what the client reports at the end of a run (plus the
// per-tier bug counts that make the score exactly recomputable).
type Result struct {
	Bugs        int `json:"bugs"`
	BugsX1      int `json:"bugs_x1"`
	BugsX2      int `json:"bugs_x2"`
	BugsX3      int `json:"bugs_x3"`
	Golden      int `json:"golden"`
	FeaturesHit int `json:"features_hit"`
	MaxCombo    int `json:"max_combo"`
	Taps        int `json:"taps"`
	Score       int `json:"score"`
}

// ScoreOf matches scoreOf() in web/src/game/score.ts.
func ScoreOf(r Result, c *Config) int {
	raw := c.PointsBug*(r.BugsX1+2*r.BugsX2+3*r.BugsX3) + c.PointsGolden*r.Golden + c.PointsFeature*r.FeaturesHit
	return max(0, raw)
}

func (r Result) Negative() bool {
	return r.Bugs < 0 || r.BugsX1 < 0 || r.BugsX2 < 0 || r.BugsX3 < 0 || r.Golden < 0 ||
		r.FeaturesHit < 0 || r.MaxCombo < 0 || r.Taps < 0 || r.Score < 0
}

// Check returns why a result is implausible for this seed, or "" if it's fine.
// Every rule here is something an honest client can never violate.
func Check(seed uint32, r Result, c *Config) string {
	if r.Negative() {
		return "negative count"
	}
	if r.Bugs != r.BugsX1+r.BugsX2+r.BugsX3 {
		return "bug tiers don't add up"
	}
	if want := ScoreOf(r, c); r.Score != want {
		return fmt.Sprintf("score %d != recomputed %d", r.Score, want)
	}
	if r.Taps > c.MaxTaps {
		return fmt.Sprintf("taps %d > %d", r.Taps, c.MaxTaps)
	}
	if r.Taps < r.Bugs+r.Golden+r.FeaturesHit {
		return "fewer taps than hits"
	}
	if r.MaxCombo > r.Bugs+r.Golden {
		return "combo longer than hits"
	}
	// Tiers are highest first: {10,×3}, {5,×2}. A bug at ×m needs combo ≥ at.
	for _, t := range c.ComboTiers {
		n := r.BugsX2
		if t.Mul == 3 {
			n = r.BugsX3
		}
		if n > 0 && r.MaxCombo < t.At {
			return fmt.Sprintf("×%d bugs without a %d combo", t.Mul, t.At)
		}
	}
	// On-screen caps turn goldens/features into plain bugs, never the reverse,
	// so plain-bug supply is the whole schedule.
	sup := SupplyOf(BuildSchedule(seed, c))
	if r.Golden > sup.Golden {
		return "more goldens than spawned"
	}
	if r.FeaturesHit > sup.Feature {
		return "more features than spawned"
	}
	if r.Bugs+r.Golden+r.FeaturesHit > sup.Total {
		return "more hits than spawns"
	}
	return ""
}
