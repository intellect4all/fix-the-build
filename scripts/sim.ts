// Headless tuning sim: plays many seeded rounds with simple player models and
// prints score distributions. Run: npm run sim
import { GAME } from '../web/src/game/config.ts';
import { buildSchedule } from '../web/src/game/schedule.ts';
import { Scorer } from '../web/src/game/score.ts';

interface Player {
  name: string;
  tapGap: number; // min seconds between taps (aim + tap)
  reaction: number; // seconds before a new bug can be targeted
  accuracy: number; // chance a targeted tap lands
  featureSlip: number; // chance per tap of hitting a feature by mistake (if one is on screen)
  goldenSkill: number; // chance of catching a golden before it leaves
}

const players: Player[] = [
  { name: 'casual', tapGap: 0.55, reaction: 0.5, accuracy: 0.7, featureSlip: 0.05, goldenSkill: 0.25 },
  { name: 'good', tapGap: 0.33, reaction: 0.3, accuracy: 0.85, featureSlip: 0.015, goldenSkill: 0.6 },
  { name: 'expert', tapGap: 0.24, reaction: 0.22, accuracy: 0.93, featureSlip: 0.005, goldenSkill: 0.85 },
  { name: 'perfect bot', tapGap: 0.12, reaction: 0.1, accuracy: 1, featureSlip: 0, goldenSkill: 1 },
];

// Approximate time a bug spends on screen: crosses ~95 % of width at a speed
// that ramps over the round, slowed by heading. Mirrors game.ts movement.
function lifetime(s: { t: number; kind: string; heading: number; speed: number; edge: string }): number {
  if (s.kind === 'golden') return GAME.goldenLifetime;
  const ramp = 1 + GAME.speedRamp * (s.t / GAME.seconds);
  const mul = s.kind === 'feature' ? GAME.featureSpeedMul : 1;
  const vert = s.edge === 'top' || s.edge === 'bottom' ? 1 / GAME.verticalAxis : 1;
  return (0.92 * vert) / (GAME.bugSpeed * ramp * mul * s.speed * Math.cos(s.heading) * 0.95);
}

function play(seed: number, p: Player, rnd: () => number) {
  const sched = buildSchedule(seed);
  const live = sched.map((s) => ({ ...s, end: s.t + lifetime(s), dead: false, hp: s.armored ? 2 : 1 }));
  const sc = new Scorer();
  let now = 0;
  let taps = 0;
  while (now < GAME.seconds) {
    sc.tick(now);
    const avail = live.filter((e) => !e.dead && e.kind !== 'feature' && e.t + p.reaction <= now && e.end > now);
    if (!avail.length) {
      now += 0.02;
      continue;
    }
    // Go for goldens first, else the bug closest to escaping.
    avail.sort((a, b) => (a.kind === 'golden' ? -1 : b.kind === 'golden' ? 1 : a.end - b.end));
    const target = avail[0];
    taps++;
    const featOnScreen = live.some((e) => !e.dead && e.kind === 'feature' && e.t <= now && e.end > now);
    if (featOnScreen && rnd() < p.featureSlip) {
      const f = live.find((e) => !e.dead && e.kind === 'feature' && e.t <= now && e.end > now)!;
      f.dead = true;
      sc.hit('feature', now);
    } else if (target.kind === 'golden') {
      target.dead = true;
      if (rnd() < p.goldenSkill) sc.hit('golden', now);
    } else {
      // evasion: darting bugs are harder to land on as the round goes on
      const evade = Math.max(0, Math.min(1, (now - GAME.evadeFrom) / (GAME.seconds - GAME.evadeFrom)));
      if (rnd() < p.accuracy * (1 - 0.22 * evade)) {
        if (target.hp > 1) { target.hp--; sc.crack(now); }
        else { target.dead = true; sc.hit('bug', now); }
      }
    }
    now += p.tapGap * (0.85 + rnd() * 0.3);
  }
  return { score: sc.score, taps, maxCombo: sc.maxCombo };
}

if (process.env.CFG) Object.assign(GAME as any, JSON.parse(process.env.CFG));
const N = 1000;
const sched0 = buildSchedule(1);
console.log(
  `spawns/round ≈ ${sched0.length} (bugs ${sched0.filter((s) => s.kind === 'bug').length}, ` +
    `golden ${sched0.filter((s) => s.kind === 'golden').length}, feat ${sched0.filter((s) => s.kind === 'feature').length})`,
);
for (const p of players) {
  const rnd = Math.random;
  const scores: number[] = [];
  let maxTaps = 0;
  for (let seed = 1; seed <= N; seed++) {
    const r = play(seed, p, rnd);
    scores.push(r.score);
    maxTaps = Math.max(maxTaps, r.taps);
  }
  scores.sort((a, b) => a - b);
  const q = (x: number) => scores[Math.floor(x * (N - 1))];
  console.log(
    `${p.name.padEnd(12)} p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}  max ${scores[N - 1]}  (max taps ${maxTaps})`,
  );
}
