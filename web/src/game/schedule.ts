// Seed → the full list of spawns for one round, computed up front.
// Only this module consumes the seeded RNG, so the sequence never depends on
// frame rate or on what the player taps. Cosmetics and evasion use Math.random.
import { GAME, type GameConfig } from './config.ts';
import { mulberry32, type Rng } from './rng.ts';

export type Kind = 'bug' | 'golden' | 'feature';
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface Spawn {
  t: number; // seconds into the round
  kind: Kind;
  edge: Edge; // which side it enters from
  pos: number; // 0..1 along that edge (left edge: which code line)
  heading: number; // radians, offset from the edge's inward direction
  speed: number; // multiplier on base speed (jitter only; ramp is applied by the game)
  armored: boolean; // bugs only: needs two taps
  swarm: boolean;
}

const EDGES: Edge[] = ['left', 'right', 'top', 'bottom'];

function pickEdge(rnd: Rng, cfg: GameConfig): Edge {
  const w = cfg.edgeWeights;
  const total = w.left + w.right + w.top + w.bottom;
  let r = rnd() * total;
  for (const e of EDGES) {
    r -= w[e];
    if (r < 0) return e;
  }
  return 'left';
}

export function buildSchedule(seed: number, cfg: GameConfig = GAME): Spawn[] {
  const rnd = mulberry32(seed);
  const out: Spawn[] = [];
  const T = cfg.seconds;
  const heading = () => (rnd() * 2 - 1) * cfg.maxHeading * 0.7;
  const speed = () => 0.85 + rnd() * 0.3;
  const armored = (t: number) => {
    const ramp = Math.max(0, (t - cfg.armoredFrom) / (T - cfg.armoredFrom));
    return rnd() < cfg.armoredChanceMax * ramp; // always draws, keeps the stream aligned
  };

  let lastGolden = -Infinity;
  let goldens = 0;
  let t = cfg.firstSpawnAt;
  while (t < T - 0.4) {
    const r = rnd();
    let kind: Kind = 'bug';
    if (t >= cfg.goldenAfter && t - lastGolden >= cfg.goldenMinGap && goldens < cfg.maxGoldenPerRound && r < cfg.goldenChance) {
      goldens++;
      kind = 'golden';
      lastGolden = t;
    } else if (r >= 1 - cfg.featureChance) {
      kind = 'feature';
    }
    const edge = pickEdge(rnd, cfg);
    const arm = armored(t) && kind === 'bug';
    out.push({ t, kind, edge, pos: rnd(), heading: heading(), speed: speed(), armored: arm, swarm: false });

    const rate = cfg.spawnRateStart + (cfg.spawnRateEnd - cfg.spawnRateStart) * (t / T);
    t += (1 / rate) * (1 + (rnd() * 2 - 1) * cfg.spawnJitter);
  }

  for (const st of cfg.swarmTimes) {
    const n = cfg.swarmMin + Math.floor(rnd() * (cfg.swarmMax - cfg.swarmMin + 1));
    const edge = pickEdge(rnd, cfg);
    const pos = 0.15 + rnd() * 0.7;
    for (let i = 0; i < n; i++) {
      out.push({
        t: st + i * cfg.swarmStagger,
        kind: 'bug',
        edge,
        pos,
        heading: (i / (n - 1) - 0.5) * 1.1 + (rnd() - 0.5) * 0.2,
        speed: speed(),
        armored: false,
        swarm: true,
      });
    }
  }

  out.sort((a, b) => a.t - b.t);
  return out;
}
