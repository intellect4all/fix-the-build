// Scoring rules, shared by the game and (ported) by the Go server.
//
//   bug     +1 × combo multiplier
//   golden  +5 flat (not multiplied), but counts as a hit and extends the combo
//   feature −3, resets the combo
//   score is never below 0
//
// The client reports how many bugs were squashed at each multiplier tier
// (bugs_x1/x2/x3), so the server can recompute the score exactly.
import { GAME, type GameConfig } from './config.ts';

export interface Tally {
  bugs_x1: number;
  bugs_x2: number;
  bugs_x3: number;
  golden: number;
  features_hit: number;
}

export function scoreOf(t: Tally, cfg: GameConfig = GAME): number {
  const p = cfg.points;
  const raw =
    p.bug * (t.bugs_x1 + 2 * t.bugs_x2 + 3 * t.bugs_x3) + p.golden * t.golden + p.feature * t.features_hit;
  return Math.max(0, raw);
}

export function multiplierFor(combo: number, cfg: GameConfig = GAME): 1 | 2 | 3 {
  for (const tier of cfg.comboTiers) if (combo >= tier.at) return tier.mul as 2 | 3;
  return 1;
}

/** Tracks combo and tally as hits come in. Time is in round seconds. */
export class Scorer {
  combo = 0;
  maxCombo = 0;
  lastHit = -Infinity;
  tally: Tally = { bugs_x1: 0, bugs_x2: 0, bugs_x3: 0, golden: 0, features_hit: 0 };

  constructor(private cfg: GameConfig = GAME) {}

  /** Call every frame (or before a hit) so the combo expires on time. */
  tick(now: number): void {
    if (this.combo > 0 && now - this.lastHit > this.cfg.comboWindow) this.combo = 0;
  }

  get multiplier(): 1 | 2 | 3 {
    return multiplierFor(this.combo, this.cfg);
  }

  /** Returns the points awarded for this hit (for floaters). */
  hit(kind: 'bug' | 'golden' | 'feature', now: number): number {
    this.tick(now);
    if (kind === 'feature') {
      this.combo = 0;
      this.tally.features_hit++;
      return this.cfg.points.feature;
    }
    this.combo++;
    this.lastHit = now;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    if (kind === 'golden') {
      this.tally.golden++;
      return this.cfg.points.golden;
    }
    const m = this.multiplier;
    if (m === 3) this.tally.bugs_x3++;
    else if (m === 2) this.tally.bugs_x2++;
    else this.tally.bugs_x1++;
    return this.cfg.points.bug * m;
  }

  /** First tap on an armored bug: no points, but it keeps the combo alive. */
  crack(now: number): void {
    this.tick(now);
    if (this.combo > 0) this.lastHit = now;
  }

  get score(): number {
    return scoreOf(this.tally, this.cfg);
  }

  get bugs(): number {
    return this.tally.bugs_x1 + this.tally.bugs_x2 + this.tally.bugs_x3;
  }
}
