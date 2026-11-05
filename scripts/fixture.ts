// Dumps TS ground truth for the Go port (internal/game). Run: npm run fixture
// Go tests fail if the server's schedule/score logic drifts from the game.
import { writeFileSync } from 'node:fs';
import { GAME } from '../web/src/game/config.ts';
import { mulberry32 } from '../web/src/game/rng.ts';
import { buildSchedule } from '../web/src/game/schedule.ts';
import { Scorer } from '../web/src/game/score.ts';

const r = mulberry32(42);
const rng = [r(), r(), r(), r(), r()];

const counts: Record<string, { n: number; bug: number; golden: number; feature: number; armored: number }> = {};
for (let seed = 1; seed <= 1000; seed++) {
  const s = buildSchedule(seed);
  counts[seed] = {
    n: s.length,
    bug: s.filter((x) => x.kind === 'bug').length,
    golden: s.filter((x) => x.kind === 'golden').length,
    feature: s.filter((x) => x.kind === 'feature').length,
    armored: s.filter((x) => x.armored).length,
  };
}
for (const seed of [0, 4294967295, 20261105, 3141592653]) {
  const s = buildSchedule(seed);
  counts[seed] = { n: s.length, bug: s.filter((x) => x.kind === 'bug').length, golden: s.filter((x) => x.kind === 'golden').length, feature: s.filter((x) => x.kind === 'feature').length, armored: s.filter((x) => x.armored).length };
}

// Random honest play through the real Scorer: the Go validator must accept every one.
const rnd = mulberry32(7);
const runs = [];
for (let i = 0; i < 3000; i++) {
  const seed = (rnd() * 4294967296) >>> 0;
  const sched = buildSchedule(seed);
  const sc = new Scorer();
  const skill = rnd();
  let taps = 0;
  let featLeft = sched.filter((x) => x.kind === 'feature').length;
  for (const sp of sched) {
    const now = sp.t + 0.1 + rnd() * 0.5 * (1 - skill);
    const misses = Math.floor(rnd() * 3 * (1 - skill));
    taps += misses;
    if (sp.kind === 'feature') {
      if (rnd() < 0.15 * (1 - skill)) { sc.hit('feature', now); taps++; featLeft--; }
      continue;
    }
    if (rnd() > 0.3 + 0.7 * skill) continue;
    if (sp.armored) { sc.crack(now); taps++; }
    sc.hit(sp.kind, now + 0.05);
    taps++;
  }
  runs.push({ seed, ...sc.tally, bugs: sc.bugs, max_combo: sc.maxCombo, taps: Math.min(taps, GAME.maxTaps), score: sc.score });
}

writeFileSync(
  'internal/game/testdata/fixture.json',
  JSON.stringify({ rng, first8: buildSchedule(20261105).slice(0, 8), counts, runs }, null, 0),
);
console.log('wrote internal/game/testdata/fixture.json');
