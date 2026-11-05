import { describe, expect, it } from 'vitest';
import { GAME } from './config.ts';
import { mulberry32 } from './rng.ts';
import { buildSchedule } from './schedule.ts';

describe('mulberry32', () => {
  it('is deterministic and matches known values (Go port must match these)', () => {
    const r = mulberry32(42);
    const seq = [r(), r(), r()].map((x) => Math.floor(x * 4294967296));
    const again = mulberry32(42);
    expect([again(), again(), again()].map((x) => Math.floor(x * 4294967296))).toEqual(seq);
    expect(seq).toMatchSnapshot();
  });
});

describe('buildSchedule', () => {
  it('same seed → identical spawn sequence', () => {
    expect(buildSchedule(1234)).toEqual(buildSchedule(1234));
  });

  it('different seeds → different sequences', () => {
    expect(buildSchedule(1)).not.toEqual(buildSchedule(2));
  });

  it('is stable across releases (snapshot)', () => {
    expect(buildSchedule(20261105).slice(0, 8)).toMatchSnapshot();
  });

  it('respects the round rules for many seeds', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const s = buildSchedule(seed);
      for (let i = 1; i < s.length; i++) expect(s[i].t).toBeGreaterThanOrEqual(s[i - 1].t);
      expect(s[s.length - 1].t).toBeLessThan(GAME.seconds);
      const goldens = s.filter((x) => x.kind === 'golden');
      expect(goldens.length).toBeLessThanOrEqual(GAME.maxGoldenPerRound);
      for (const g of goldens) expect(g.t).toBeGreaterThanOrEqual(GAME.goldenAfter);
      for (const a of s.filter((x) => x.armored)) {
        expect(a.kind).toBe('bug');
        expect(a.t).toBeGreaterThanOrEqual(GAME.armoredFrom);
      }
      const swarm = s.filter((x) => x.swarm);
      expect(swarm.length).toBeGreaterThanOrEqual(GAME.swarmMin * 2);
      expect(swarm.length).toBeLessThanOrEqual(GAME.swarmMax * 2);
    }
  });

  it('spawns from all four edges', () => {
    const edges = new Set(buildSchedule(99).map((x) => x.edge));
    expect([...edges].sort()).toEqual(['bottom', 'left', 'right', 'top']);
  });
});
