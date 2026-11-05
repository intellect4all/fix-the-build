// PR page entry: page ↔ game ↔ merge ↔ results.
import './styles.css';
import { ApiError, api, type Config, type FinishResp, type Me, type RunStart } from './api.ts';
import { BugSwarm, type RunResult } from './game.ts';
import { showMergeForm } from './merge.ts';
import { PrPage } from './pr.ts';
import { renderResults } from './results.ts';

const $ = (id: string) => document.getElementById(id)!;

/** Shown while waiting on slow mobile data, only if the wait is noticeable. */
function pending(text: string): () => void {
  const t = setTimeout(() => {
    sheet.innerHTML = `<div class="bs-card"><p class="bs-quip">⏳ ${text}</p></div>`;
    sheet.hidden = false;
  }, 400);
  return () => { clearTimeout(t); };
}
const overlay = $('play');
const sheet = $('sheet');
const mute = $('mute') as HTMLButtonElement;

let cfg: Config;
let me: Me;
let game: BugSwarm | null = null;
let busy = false;

const page = new PrPage($('app'), () => void play(), () => void refresh());

async function refresh() {
  me = await api.me();
  page.update({ cfg, me, board: await api.leaderboard(50) });
}

// ---------------------------------------------------------------- game overlay

function openOverlay() {
  overlay.hidden = false;
  document.documentElement.classList.add('playing');
  if (!game) {
    game = new BugSwarm($('game'));
    const paint = () => (mute.textContent = game!.sfx.enabled ? '🔊' : '🔇');
    paint();
    mute.onclick = () => { game!.sfx.toggle(); paint(); };
  }
}

function closeOverlay() {
  overlay.hidden = true;
  sheet.hidden = true;
  document.documentElement.classList.remove('playing');
}

async function play() {
  if (busy) return;
  busy = true;
  sheet.hidden = true;
  openOverlay();
  const prevBest = me.best;
  let run: RunStart;
  const done = pending('Starting CI runner…');
  try {
    run = await api.startRun();
    done();
    sheet.hidden = true;
  } catch (e) {
    done();
    busy = false;
    const limited = e instanceof ApiError && e.code === 'rate_limited';
    sheet.innerHTML = `<div class="bs-card"><p class="bs-verdict fail">${limited ? '⏳ CI runner busy' : '⚠️ CI runner unreachable'}</p><p class="bs-quip">${limited ? 'One push every 5 seconds. Try again in a moment.' : 'The network is having a moment. Try again?'}</p><div class="bs-btns"><button class="bs-btn primary" data-act="retry">Retry</button><button class="bs-btn" data-act="close">Back</button></div></div>`;
    sheet.hidden = false;
    sheet.querySelector<HTMLElement>('[data-act=retry]')!.onclick = () => void play();
    sheet.querySelector<HTMLElement>('[data-act=close]')!.onclick = closeOverlay;
    return;
  }
  busy = false;
  game!.start({ seed: run.seed, onEnd: (r) => void finished(run, r, prevBest) });
}

async function finished(run: RunStart, r: RunResult, prevBest: number | null) {
  let resp: FinishResp;
  const done = pending('Pushing to CI…');
  try {
    resp = await api.finishRun(run.run_id, {
      bugs: r.bugs, bugs_x1: r.bugs_x1, bugs_x2: r.bugs_x2, bugs_x3: r.bugs_x3,
      golden: r.golden, features_hit: r.features_hit, max_combo: r.max_combo, taps: r.taps, score: r.score,
    });
  } catch {
    // Show the run anyway; it just won't count.
    resp = { score: r.score, best: Math.max(prevBest ?? 0, r.score), is_new_best: false, rank: null };
  }
  done();

  if (!me.merged) {
    const merged = await showMergeForm(sheet, { score: r.score, runId: run.run_id, pushes: me.pushes + 1, passThreshold: cfg.pass_threshold });
    me = merged ?? (await api.me());
    if (merged?.merged) resp = { ...resp, rank: merged.rank, best: merged.best };
  } else {
    me = await api.me();
  }

  renderResults(sheet, {
    run: r,
    passThreshold: cfg.pass_threshold,
    prevBest,
    best: resp.best,
    isNewBest: resp.is_new_best,
    rank: me.merged ? resp.rank : null,
    passed: resp.passed_player,
  }, {
    again: () => void play(),
    commits: () => { closeOverlay(); page.setTab('commits'); window.scrollTo(0, 0); void refresh(); },
  });
  void refresh();
}

// ---------------------------------------------------------------- polling (every 10 s while visible)

setInterval(async () => {
  if (document.hidden || !overlay.hidden) return;
  try { page.setBoard(await api.leaderboard(50)); } catch { /* try again next tick */ }
}, 10_000);

// ---------------------------------------------------------------- boot

async function boot() {
  try {
    cfg = await api.config();
    await refresh();
  } catch {
    $('app').innerHTML = '<main class="wrap"><h1 class="title">Add you to my network <span class="num">#1</span></h1><p class="dim pad">Can’t reach the CI server. <button class="linkish" id="retry" type="button">Retry</button></p></main>';
    $('retry').onclick = () => void boot();
  }
}
void boot();
