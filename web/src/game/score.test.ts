import { describe, expect, it } from 'vitest';
import { Scorer, scoreOf } from './score.ts';

describe('scoreOf', () => {
  it('weights tiers, goldens and features', () => {
    expect(scoreOf({ bugs_x1: 4, bugs_x2: 5, bugs_x3: 3, golden: 1, features_hit: 1 })).toBe(4 + 10 + 9 + 5 - 3);
  });
  it('never goes below zero', () => {
    expect(scoreOf({ bugs_x1: 1, bugs_x2: 0, bugs_x3: 0, golden: 0, features_hit: 2 })).toBe(0);
  });
});

describe('Scorer combo rules', () => {
  it('×2 from the 5th consecutive hit, ×3 from the 10th', () => {
    const s = new Scorer();
    const pts: number[] = [];
    for (let i = 0; i < 12; i++) pts.push(s.hit('bug', i * 0.5));
    expect(pts).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3]);
    expect(s.score).toBe(4 + 10 + 9);
    expect(s.maxCombo).toBe(12);
  });

  it('a gap longer than 0.8 s resets the combo', () => {
    const s = new Scorer();
    for (let i = 0; i < 5; i++) s.hit('bug', i * 0.5);
    expect(s.multiplier).toBe(2);
    expect(s.hit('bug', 2 + 0.81)).toBe(1);
    expect(s.combo).toBe(1);
  });

  it('a feature resets the combo and costs 3', () => {
    const s = new Scorer();
    for (let i = 0; i < 6; i++) s.hit('bug', i * 0.1);
    expect(s.hit('feature', 0.7)).toBe(-3);
    expect(s.combo).toBe(0);
    expect(s.hit('bug', 0.8)).toBe(1);
  });

  it('golden is +5 flat but extends the combo', () => {
    const s = new Scorer();
    for (let i = 0; i < 4; i++) s.hit('bug', i * 0.1);
    expect(s.hit('golden', 0.4)).toBe(5);
    expect(s.combo).toBe(5);
    expect(s.hit('bug', 0.5)).toBe(2);
    expect(s.tally).toEqual({ bugs_x1: 4, bugs_x2: 1, bugs_x3: 0, golden: 1, features_hit: 0 });
  });

  it('cracking an armored bug scores nothing but keeps the combo alive', () => {
    const s = new Scorer();
    for (let i = 0; i < 3; i++) s.hit('bug', i * 0.5); // last hit at 1.0
    s.crack(1.7);
    expect(s.score).toBe(3);
    expect(s.hit('bug', 2.4)).toBe(1); // 0.7 s after the crack: combo still alive
    expect(s.combo).toBe(4);
  });
});
