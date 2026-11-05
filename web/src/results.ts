// Results screen, shared by the PR page and /play-test.
import type { RunResult } from './game.ts';
import { FAIL_LINES, PASS_LINES, esc, pick } from './copy.ts';

export interface ResultView {
  run: RunResult;
  passThreshold: number;
  prevBest: number | null; // best before this run (null = first ever run)
  best: number;
  isNewBest: boolean;
  rank: number | null;
  passed?: string;
}

export function renderResults(el: HTMLElement, v: ResultView, on: { again: () => void; commits?: () => void }) {
  const r = v.run;
  const pass = r.score >= v.passThreshold;
  const amended = v.isNewBest && v.prevBest !== null
    ? `<p class="bs-amend">amended: ${v.prevBest} → ${r.score} 🐛${v.rank ? ` · now <b>#${v.rank}</b>` : ''}</p>`
    : v.isNewBest && v.rank ? `<p class="bs-amend">new best · <b>#${v.rank}</b> in the commit history</p>` : '';
  const passed = v.passed ? `<p class="bs-amend">You passed <b>${esc(v.passed)}</b> 🏎️</p>` : '';
  const notBest = !v.isNewBest && v.prevBest !== null ? `<span>best ${v.best}</span>` : '';
  el.innerHTML = `
    <div class="bs-card" role="dialog" aria-label="Results">
      <p class="bs-verdict ${pass ? 'pass' : 'fail'}">${pass ? '✅ All checks passed' : '⚠️ Checks failing — merging anyway'}</p>
      <p class="bs-quip">${pick(pass ? PASS_LINES : FAIL_LINES)}</p>
      <div class="bs-score">${r.score} <small>pts ${notBest}</small></div>
      ${amended}${passed}
      <table class="bs-rows">
        <tr><td>🐛 bugs squashed</td><td>${r.bugs}${r.bugs_x2 + r.bugs_x3 ? ` <span class="dim">(${r.bugs_x2}×2, ${r.bugs_x3}×3)</span>` : ''}</td></tr>
        <tr><td>✨ golden bugs</td><td>${r.golden}${r.golden ? ` <span class="dim">(+${r.golden * 5})</span>` : ''}</td></tr>
        <tr><td>✓ features squashed</td><td class="${r.features_hit ? 'neg' : ''}">${r.features_hit ? `${r.features_hit} (−${r.features_hit * 3})` : '0 👌'}</td></tr>
        <tr><td>🔥 max combo</td><td>${r.max_combo}</td></tr>
        <tr><td>🏃 escaped</td><td>${r.escaped}</td></tr>
      </table>
      <div class="bs-btns">
        <button class="bs-btn primary" data-act="again" type="button">Play again</button>
        ${on.commits ? '<button class="bs-btn" data-act="commits" type="button">View commits</button>' : ''}
      </div>
      <div class="bs-meta">seed ${r.seed} · ${r.taps} taps</div>
    </div>`;
  el.hidden = false;
  el.querySelector<HTMLButtonElement>('[data-act=again]')!.onclick = on.again;
  const c = el.querySelector<HTMLButtonElement>('[data-act=commits]');
  if (c && on.commits) c.onclick = on.commits;
}
