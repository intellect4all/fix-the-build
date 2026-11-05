// Every Bug Swarm tuning knob lives here. Change numbers, not code.
// Final tuning and the reasoning behind it is recorded in DECISIONS.md.

export const GAME = {
  seconds: 20,

  // Spawning. Rate ramps linearly from start to end.
  spawnRateStart: 1.0, // spawns per second at t=0
  spawnRateEnd: 3.0, // spawns per second at t=end
  spawnJitter: 0.3, // interval multiplied by 1 ± jitter
  firstSpawnAt: 0.35, // seconds after the round starts

  goldenAfter: 3, // seconds before goldens can appear
  goldenChance: 0.08, // per regular spawn
  goldenMinGap: 1.7, // schedule-level cap: never two goldens closer than this (lifetime is 1.5 s)
  goldenLifetime: 1.5,
  maxGoldenPerRound: 2,
  maxGoldenOnScreen: 1,

  featureChance: 0.15,
  maxFeaturesOnScreen: 2,

  // Where spawns enter from (weights). Left = crawling out of the code.
  edgeWeights: { left: 0.4, right: 0.25, top: 0.15, bottom: 0.2 },

  // Evasion ramps linearly from 0 at evadeFrom to 1 at the end of the round.
  evadeFrom: 4,
  dodgeRadius: 110, // CSS px: a missed tap this close may make a bug jink away
  dodgeChance: 0.75, // at full ramp (goldens always dodge)
  dodgeSpeed: 420, // px/s impulse, decays quickly
  dartRate: 0.9, // random sideways darts per bug per second at full ramp

  // Armored bugs need two taps. Chance ramps from 0 at armoredFrom to max at the end.
  armoredFrom: 6,
  armoredChanceMax: 0.35,

  swarmTimes: [8, 15], // seconds
  swarmMin: 5,
  swarmMax: 7,
  swarmStagger: 0.07, // seconds between bugs in a burst

  // Movement. Speeds are fractions of the crossing axis per second, so the
  // game plays the same on a 360 px phone and a wide laptop.
  bugSpeed: 0.34, // ≈2.9 s to cross at the start, ≈1.8 s at the end
  speedRamp: 0.6, // +60 % by the end of the round
  goldenSpeedMul: 1.9,
  featureSpeedMul: 0.55,
  turnRate: 2.2, // max random heading change, rad/s
  goldenTurnRate: 7,
  maxHeading: 0.75, // rad away from the entry direction
  verticalAxis: 0.75, // top/bottom entries: fraction of playfield height used as the speed axis

  // Scoring. See score.ts.
  points: { bug: 1, golden: 5, feature: -3 },
  comboWindow: 0.8, // seconds
  comboTiers: [
    { at: 10, mul: 3 },
    { at: 5, mul: 2 },
  ],

  // Touch.
  hitRadius: 30, // CSS px, minimum 28
  maxDpr: 2,

  // Feel.
  splatMs: 300,
  endFreezeMs: 600,
  redTimerAt: 5, // seconds remaining
  countdownFrom: 3,

  // Integrity. Mirrored by the Go server.
  passThreshold: 15,
  maxTaps: 400,
} as const;

export type GameConfig = typeof GAME;
