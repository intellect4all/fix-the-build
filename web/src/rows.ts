// One commit row in the history. Used by the Commits tab, the
// merge-form preview and the big-screen board.
import type { Row } from './api.ts';
import { esc } from './copy.ts';
import { profileUrl } from './handle.ts';

export const handleLabel = (r: Pick<Row, 'handle_type' | 'handle'>) =>
  r.handle_type === 'x' ? `@${r.handle}` : `in/${r.handle}`;

export function rowHtml(r: Row, pass: number, opts: { preview?: boolean } = {}): string {
  const ok = r.best >= pass;
  const handle = opts.preview
    ? `<span class="c-handle">${esc(handleLabel(r))}</span>`
    : `<a class="c-handle" href="${esc(profileUrl({ type: r.handle_type, handle: r.handle }))}" target="_blank" rel="noopener noreferrer">${esc(handleLabel(r))}</a>`;
  return `<li class="commit${r.me ? ' me' : ''}${opts.preview ? ' preview' : ''}">
    <span class="c-icon" title="${ok ? 'checks passed' : 'checks failing'}">${ok ? '✅' : '⚠️'}</span>
    <div class="c-main">
      <div class="c-msg">${esc(r.commit_message || 'fix: …')}</div>
      <div class="c-meta"><code class="c-hash">${esc(r.hash)}</code> ${handle} <span class="c-name">${esc(r.name)}</span></div>
    </div>
    <div class="c-score"><b>${r.best} 🐛</b><span>${r.pushes} push${r.pushes === 1 ? '' : 'es'}</span></div>
  </li>`;
}
