// /board: top 10 + highlights + QR, polling /api/stats every 5 s.
// Rows are keyed by commit hash and animated with FLIP when ranks change.
import './board.css';
import qrcode from 'qrcode-generator';
import { esc } from './copy.ts';
import type { Config, Row } from './api.ts';
import { handleLabel } from './rows.ts';

interface Stats {
  total_players: number;
  total_pushes: number;
  top: Row[];
  top_contributor: Row | null;
  most_pushes: Row | null;
  latest_merge: Row | null;
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const list = $<HTMLOListElement>('[data-rows]');
let cfg: Config;
const prevBest = new Map<string, number>();

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function rowEl(r: Row): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'b-row';
  li.dataset.key = r.hash;
  return li;
}

function paintRow(li: HTMLLIElement, r: Row) {
  const pass = r.best >= cfg.pass_threshold;
  li.classList.toggle('top', r.rank <= 3);
  li.innerHTML = `
    <span class="b-rank">${r.rank}</span>
    <span aria-hidden="true">${pass ? '✅' : '⚠️'}</span>
    <div class="b-body">
      <div class="b-msg">${esc(r.commit_message)}</div>
      <div class="b-meta"><code>${esc(r.hash)}</code> · <b>${esc(handleLabel(r))}</b> · ${esc(r.name)}</div>
    </div>
    <div class="b-score">${r.best} 🐛<small>${r.pushes} push${r.pushes === 1 ? '' : 'es'}</small></div>`;
}

function renderRows(rows: Row[]) {
  $('[data-empty]').hidden = rows.length > 0;
  const old = new Map<string, HTMLLIElement>();
  const first = new Map<string, number>();
  for (const li of list.children as HTMLCollectionOf<HTMLLIElement>) {
    old.set(li.dataset.key!, li);
    first.set(li.dataset.key!, li.getBoundingClientRect().top);
  }
  const next: HTMLLIElement[] = [];
  for (const r of rows) {
    const li = old.get(r.hash) ?? rowEl(r);
    const isNew = !old.has(r.hash);
    paintRow(li, r);
    li.classList.remove('bump', 'enter');
    const before = prevBest.get(r.hash);
    if (isNew && first.size) li.classList.add('enter');
    else if (before !== undefined && r.best > before) { void li.offsetWidth; li.classList.add('bump'); }
    prevBest.set(r.hash, r.best);
    next.push(li);
  }
  list.replaceChildren(...next);
  // FLIP: start each moved row at its old position, then let it slide.
  for (const li of next) {
    const was = first.get(li.dataset.key!);
    if (was === undefined) continue;
    const dy = was - li.getBoundingClientRect().top;
    if (!dy) continue;
    li.style.transition = 'none';
    li.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      li.style.transition = 'transform .7s cubic-bezier(.2,.8,.2,1)';
      li.style.transform = '';
    });
  }
}

function hl(icon: string, label: string, r: Row | null, extra: (r: Row) => string) {
  return `<li><div class="k">${icon} ${label}</div><div class="v">${r ? `${esc(handleLabel(r))} <small>${esc(extra(r))}</small>` : '<small>—</small>'}</div></li>`;
}

function render(s: Stats) {
  renderRows(s.top.slice(0, 10));
  $('[data-players]').textContent = String(s.total_players);
  $('[data-pushes]').textContent = String(s.total_pushes);
  $('[data-hl]').innerHTML =
    hl('🏆', 'Top contributor', s.top_contributor, (r) => `${r.best} 🐛`) +
    hl('🔁', 'Most pushes', s.most_pushes, (r) => `${r.pushes} pushes`) +
    hl('⑂', 'Latest merge', s.latest_merge, (r) => r.commit_message);
}

async function tick() {
  try { render(await get<Stats>('/api/stats')); } catch { /* keep the last good frame */ }
}

(async () => {
  cfg = await get<Config>('/api/config');
  document.querySelector('[data-owner]')!.textContent = cfg.organiser_handle;
  document.querySelector('[data-branch]')!.textContent = `${cfg.organiser_handle}:main`;
  const url = cfg.base_url || location.origin;
  $('[data-url]').textContent = url.replace(/^https?:\/\//, '');
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  $('[data-qr]').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  await tick();
  setInterval(tick, 5000);
})();
