// /play-test: Bug Swarm standalone, no backend. ?seed=123 to replay a seed, ?fps=0 to hide the meter.
import './styles.css';
import { BugSwarm, type RunResult } from './game.ts';
import { GAME } from './game/config.ts';
import { randomSeed } from './game/rng.ts';
import { renderResults } from './results.ts';

const params = new URLSearchParams(location.search);
// ?preset=classic plays the original, calmer density (1.2→3.5 spawns/s, swarms 5–8) for A/B feel tests.
if (params.get('preset') === 'classic') {
  Object.assign(GAME as any, { spawnRateStart: 1.2, spawnRateEnd: 3.5, spawnJitter: 0.45, swarmMax: 8 });
}
const fixedSeed = params.has('seed') ? Number(params.get('seed')) >>> 0 : null;
const game = new BugSwarm(document.getElementById('game')!);
game.showFps = params.get('fps') !== '0';

const mute = document.getElementById('mute') as HTMLButtonElement;
const paintMute = () => (mute.textContent = game.sfx.enabled ? '🔊' : '🔇');
paintMute();
mute.addEventListener('click', () => { game.sfx.toggle(); paintMute(); });

const results = document.getElementById('results')!;
let best = 0;
let rounds = 0;

function play() {
  results.hidden = true;
  game.start({ seed: fixedSeed ?? randomSeed(), onEnd: showResults });
}

function showResults(r: RunResult) {
  rounds++;
  const prev = rounds > 1 ? best : null;
  best = Math.max(best, r.score);
  renderResults(results, {
    run: r, passThreshold: GAME.passThreshold, prevBest: prev, best,
    isNewBest: prev === null || r.score > prev, rank: null,
  }, { again: play });
}

play();
