package game

import (
	"math"
	"sort"
)

// Mulberry32 matches web/src/game/rng.ts bit for bit.
func Mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := a
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		return float64(t^(t>>14)) / 4294967296
	}
}

type Kind string

const (
	Bug     Kind = "bug"
	Golden  Kind = "golden"
	Feature Kind = "feature"
)

var edges = [4]string{"left", "right", "top", "bottom"}

type Spawn struct {
	T       float64 `json:"t"`
	Kind    Kind    `json:"kind"`
	Edge    string  `json:"edge"`
	Pos     float64 `json:"pos"`
	Heading float64 `json:"heading"`
	Speed   float64 `json:"speed"`
	Armored bool    `json:"armored"`
	Swarm   bool    `json:"swarm"`
}

// The explicit float64(...) conversions stop the compiler fusing a*b+c into
// one FMA instruction (it does on arm64, not amd64). JS never fuses, so
// without them the last bit can differ and shift a spawn across a threshold.

func pickEdge(rnd func() float64, c *Config) string {
	w := c.EdgeWeights
	total := w[0] + w[1] + w[2] + w[3]
	r := float64(rnd() * total)
	for i, e := range edges {
		r -= w[i]
		if r < 0 {
			return e
		}
	}
	return "left"
}

// BuildSchedule matches buildSchedule() in web/src/game/schedule.ts, including
// the exact order in which it draws from the RNG.
func BuildSchedule(seed uint32, c *Config) []Spawn {
	rnd := Mulberry32(seed)
	T := c.Seconds
	heading := func() float64 { return float64(float64(float64(rnd()*2)-1)*c.MaxHeading) * 0.7 }
	speed := func() float64 { return 0.85 + float64(rnd()*0.3) }
	armored := func(t float64) bool {
		ramp := math.Max(0, (t-c.ArmoredFrom)/(T-c.ArmoredFrom))
		return rnd() < float64(c.ArmoredChanceMax*ramp)
	}

	var out []Spawn
	lastGolden := math.Inf(-1)
	goldens := 0
	t := c.FirstSpawnAt
	for t < T-0.4 {
		r := rnd()
		kind := Bug
		if t >= c.GoldenAfter && t-lastGolden >= c.GoldenMinGap && goldens < c.MaxGoldenPerRound && r < c.GoldenChance {
			goldens++
			kind = Golden
			lastGolden = t
		} else if r >= 1-c.FeatureChance {
			kind = Feature
		}
		edge := pickEdge(rnd, c)
		arm := armored(t) && kind == Bug
		pos := rnd()
		h := heading()
		sp := speed()
		out = append(out, Spawn{T: t, Kind: kind, Edge: edge, Pos: pos, Heading: h, Speed: sp, Armored: arm})

		rate := c.SpawnRateStart + float64((c.SpawnRateEnd-c.SpawnRateStart)*(t/T))
		jit := 1 + float64(float64(float64(rnd()*2)-1)*c.SpawnJitter)
		t += float64((1 / rate) * jit)
	}

	for _, st := range c.SwarmTimes {
		n := c.SwarmMin + int(math.Floor(rnd()*float64(c.SwarmMax-c.SwarmMin+1)))
		edge := pickEdge(rnd, c)
		pos := 0.15 + float64(rnd()*0.7)
		for i := 0; i < n; i++ {
			h := float64((float64(i)/float64(n-1)-0.5)*1.1) + float64((rnd()-0.5)*0.2)
			out = append(out, Spawn{
				T: st + float64(float64(i)*c.SwarmStagger), Kind: Bug, Edge: edge, Pos: pos,
				Heading: h, Speed: speed(), Swarm: true,
			})
		}
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

// Supply is how many of each kind a round can possibly offer.
type Supply struct{ Total, Golden, Feature int }

func SupplyOf(s []Spawn) Supply {
	var sup Supply
	sup.Total = len(s)
	for _, x := range s {
		switch x.Kind {
		case Golden:
			sup.Golden++
		case Feature:
			sup.Feature++
		}
	}
	return sup
}
