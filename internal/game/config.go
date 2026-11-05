// Package game mirrors the client's seeded spawn schedule and scoring rules
// (web/src/game/*.ts) so the server can verify a run. The fixture test in
// game_test.go fails if this port drifts from the TypeScript.
package game

// Config mirrors the parts of web/src/game/config.ts that affect the
// schedule or the score. Keep the two in sync; `npm run fixture` regenerates
// the cross-check data.
type Config struct {
	Seconds                                 float64
	SpawnRateStart, SpawnRateEnd            float64
	SpawnJitter, FirstSpawnAt               float64
	GoldenAfter, GoldenChance, GoldenMinGap float64
	MaxGoldenPerRound                       int
	FeatureChance                           float64
	EdgeWeights                             [4]float64 // left, right, top, bottom
	ArmoredFrom, ArmoredChanceMax           float64
	SwarmTimes                              []float64
	SwarmMin, SwarmMax                      int
	SwarmStagger                            float64
	MaxHeading                              float64

	PointsBug, PointsGolden, PointsFeature int
	ComboTiers                             []Tier // highest first
	MaxTaps                                int
}

type Tier struct{ At, Mul int }

var Default = Config{
	Seconds:           20,
	SpawnRateStart:    1.0,
	SpawnRateEnd:      3.0,
	SpawnJitter:       0.3,
	FirstSpawnAt:      0.35,
	GoldenAfter:       3,
	GoldenChance:      0.08,
	GoldenMinGap:      1.7,
	MaxGoldenPerRound: 2,
	FeatureChance:     0.15,
	EdgeWeights:       [4]float64{0.4, 0.25, 0.15, 0.2},
	ArmoredFrom:       6,
	ArmoredChanceMax:  0.35,
	SwarmTimes:        []float64{8, 15},
	SwarmMin:          5,
	SwarmMax:          7,
	SwarmStagger:      0.07,
	MaxHeading:        0.75,

	PointsBug:     1,
	PointsGolden:  5,
	PointsFeature: -3,
	ComboTiers:    []Tier{{10, 3}, {5, 2}},
	MaxTaps:       400,
}
