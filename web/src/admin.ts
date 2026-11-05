// /admin: list players, hide/unhide, edit commit messages, link a new phone,
// export CSV, see flagged runs. Auth is an HttpOnly cookie set by /api/admin/login.
import './styles.css';
import './admin.css';
import { esc } from './copy.ts';
import { handleLabel } from './rows.ts';

interface P {
  id: number; device: string; name: string; handle_type: 'x' | 'linkedin'; handle: string; commit_message: string;
  hidden: boolean; created_at: number; best: number | null; pushes: number; flagged: number; rank: number;
}
interface F { id: string; device: string; player_name?: string; handle?: string; score: number; taps: number; reason: string; finished_at: number }
interface Data { totals: { players: number; runs: number; flagged: number; devices: number }; players: P[]; flagged: F[] }

const root = document.getElementById('admin')!;
let data: Data | null = null;
let filter = '';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function errText(r: Response) {
  try { return (await r.json()).error?.message ?? `HTTP ${r.status}`; } catch { return `HTTP ${r.status}`; }
}

function login(msg = '') {
  root.innerHTML = `
    <form class="login" data-login>
      <h1>Admin</h1>
      <input type="password" name="token" placeholder="ADMIN_TOKEN" autocomplete="current-password" required />
      <button class="primary" type="submit">Sign in</button>
      <p class="err">${esc(msg)}</p>
    </form>`;
  const f = root.querySelector<HTMLFormElement>('[data-login]')!;
  f.querySelector('input')!.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await call('POST', '/api/admin/login', { token: (f.elements.namedItem('token') as HTMLInputElement).value });
    if (r.ok) return load();
    login(await errText(r));
  };
}

async function load() {
  const r = await call('GET', '/api/admin/players');
  if (r.status === 401) return login();
  if (!r.ok) { root.innerHTML = `<p class="err">${esc(await errText(r))}</p>`; return; }
  data = await r.json();
  render();
}

const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function render() {
  if (!data) return;
  const q = filter.toLowerCase();
  const ps = data.players.filter((p) => !q || `${p.name} ${p.handle} ${p.commit_message} ${p.device}`.toLowerCase().includes(q));
  const t = data.totals;
  const focus = document.activeElement?.getAttribute('name');
  root.innerHTML = `
    <h1>Fix the Build · admin</h1>
    <div class="totals"><span><b>${t.players}</b> players</span><span><b>${t.runs}</b> finished runs</span><span><b>${t.devices}</b> devices</span><span><b>${t.flagged}</b> flagged</span></div>
    <div class="bar">
      <input type="search" name="q" placeholder="Search name, handle, message, device code" value="${esc(filter)}" />
      <button data-act="refresh" type="button">Refresh</button>
      <a class="btn" href="/api/admin/export.csv" download>Export CSV</a>
      <a class="btn" href="/board" target="_blank" rel="noopener">Open board</a>
      <button data-act="logout" type="button">Sign out</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>Player</th><th>Commit message</th><th>Best</th><th>Pushes</th><th>Flagged</th><th>Device</th><th>Joined</th><th></th></tr></thead>
      <tbody>${ps.map(row).join('') || '<tr><td colspan="9" class="dim">No players.</td></tr>'}</tbody>
    </table></div>
    <p class="note">Link a new phone: the player plays one round on it, reads you the device code from the error, then press <b>Link phone</b> on their row.</p>
    <h2>Recent flagged runs</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>When</th><th>Device</th><th>Player</th><th>Score</th><th>Taps</th><th>Reason</th></tr></thead>
      <tbody>${data.flagged.map((f) => `<tr><td>${when(f.finished_at)}</td><td><code>${esc(f.device)}</code></td><td>${esc(f.player_name || '—')} ${f.handle ? `<span class="dim">${esc(f.handle)}</span>` : ''}</td><td class="num">${f.score}</td><td class="num">${f.taps}</td><td>${esc(f.reason)}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">None. Nobody has tried yet.</td></tr>'}</tbody>
    </table></div>`;
  if (focus === 'q') {
    const s = root.querySelector<HTMLInputElement>('[name=q]')!;
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  }
}

function row(p: P) {
  const url = p.handle_type === 'x' ? `https://x.com/${p.handle}` : `https://www.linkedin.com/in/${p.handle}`;
  return `<tr class="${p.hidden ? 'hidden' : ''}" data-id="${p.id}">
    <td class="num">${p.hidden ? 'hidden' : p.rank || '—'}</td>
    <td><b>${esc(p.name)}</b><br><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(handleLabel(p))}</a></td>
    <td class="msg">${esc(p.commit_message)}</td>
    <td class="num">${p.best ?? '—'}</td>
    <td class="num">${p.pushes}</td>
    <td class="num ${p.flagged ? 'flag' : ''}">${p.flagged}</td>
    <td><code>${esc(p.device)}</code></td>
    <td>${when(p.created_at)}</td>
    <td class="acts">
      <button data-act="edit" type="button">Edit msg</button>
      <button data-act="hide" type="button">${p.hidden ? 'Unhide' : 'Hide'}</button>
      <button data-act="link" type="button">Link phone</button>
    </td>
  </tr>`;
}

async function patch(id: number, body: Record<string, unknown>) {
  const r = await call('PATCH', `/api/admin/players/${id}`, body);
  if (!r.ok) {
    const msg = await errText(r);
    const bar = root.querySelector('.bar');
    bar?.insertAdjacentHTML('afterend', `<p class="err" data-tmp>${esc(msg)}</p>`);
    setTimeout(() => root.querySelector('[data-tmp]')?.remove(), 5000);
    return;
  }
  await load();
}

// Inline prompt (no window.prompt: it blocks and looks broken on phones).
function inlineEdit(tr: HTMLElement, label: string, value: string, maxlength: number, onSave: (v: string) => void) {
  const cell = tr.querySelector<HTMLElement>('.acts')!;
  cell.innerHTML = `<form data-inline><input name="v" maxlength="${maxlength}" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}" />
    <button class="primary" type="submit">Save</button> <button type="button" data-act="cancel">Cancel</button></form>`;
  const f = cell.querySelector<HTMLFormElement>('form')!;
  const input = f.querySelector('input')!;
  input.focus();
  input.select();
  f.onsubmit = (e) => { e.preventDefault(); onSave(input.value); };
}

root.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.name === 'q') { filter = t.value; render(); }
});

root.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b || !data) return;
  const tr = b.closest<HTMLElement>('tr[data-id]');
  const p = tr ? data.players.find((x) => x.id === Number(tr.dataset.id)) : undefined;
  switch (b.dataset.act) {
    case 'refresh': return load();
    case 'logout': await call('POST', '/api/admin/logout'); return login();
    case 'cancel': return render();
    case 'hide': if (p) await patch(p.id, { hidden: !p.hidden }); return;
    case 'edit': if (p && tr) inlineEdit(tr, 'Commit message', p.commit_message, 72, (v) => void patch(p.id, { commit_message: v })); return;
    case 'link': if (p && tr) inlineEdit(tr, 'Device code of the new phone', '', 36, (v) => void patch(p.id, { device: v })); return;
  }
});

void load();
