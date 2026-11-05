// The PR page: header, tabs, Conversation / Commits / Checks.
import { ApiError, api, deviceToken, type Config, type Leaderboard, type Me } from './api.ts';
import { esc } from './copy.ts';
import { oneLine } from './merge.ts';
import { handleLabel, rowHtml } from './rows.ts';

export type Tab = 'conversation' | 'commits' | 'checks';

export interface PageState {
  cfg: Config;
  me: Me;
  board: Leaderboard | null;
}

export class PrPage {
  private tab: Tab = 'conversation';
  private s!: PageState;
  private confirmDelete = false;
  private editing = false;

  constructor(private root: HTMLElement, private onPlay: () => void, private onChanged: () => void) {
    root.addEventListener('click', this.onClick);
    window.addEventListener('hashchange', () => this.setTab(tabFromHash(), false));
    this.tab = tabFromHash();
  }

  update(s: PageState) {
    this.s = s;
    this.render();
  }

  /** Poll result: only re-render if it's visible, so open forms aren't clobbered. */
  setBoard(board: Leaderboard) {
    const changed = JSON.stringify(board) !== JSON.stringify(this.s.board);
    this.s.board = board;
    if (changed && this.tab === 'commits') this.render();
  }

  setTab(t: Tab, pushHash = true) {
    this.tab = t;
    this.confirmDelete = false;
    if (pushHash) history.replaceState(null, '', t === 'conversation' ? location.pathname : `#${t}`);
    this.render();
  }

  get currentTab() { return this.tab; }

  private render() {
    const { cfg, me, board } = this.s;
    const merged = me.merged;
    const total = board?.total_players ?? 0;
    this.root.innerHTML = `
      <header class="topbar"><span class="mark">◆</span> <b>${esc(cfg.organiser_handle)}</b> / network</header>
      <main class="wrap">
        <h1 class="title">Add you to my network <span class="num">#1</span></h1>
        <div class="sub">
          <span class="pill ${merged ? 'merged' : 'open'}">⑂ ${merged ? 'Merged' : 'Open'}</span>
          <span><code class="branch">you:connect</code> → <code class="branch">${esc(cfg.organiser_handle)}:main</code> · opened by <b>@${esc(cfg.organiser_handle)}</b></span>
        </div>
        <nav class="tabs" role="tablist">
          ${tabBtn('conversation', '💬 Conversation', '', this.tab)}
          ${tabBtn('commits', '⎇ Commits', String(total), this.tab)}
          ${tabBtn('checks', '☑ Checks', merged && me.best >= cfg.pass_threshold ? '✓' : '1', this.tab)}
        </nav>
        <section class="panel">${this.tab === 'commits' ? this.commits() : this.tab === 'checks' ? this.checks() : this.conversation()}</section>
        <footer class="foot">${esc(cfg.event_name)} · <a href="/privacy">privacy</a></footer>
      </main>`;
  }

  // ------------------------------------------------------------ conversation

  private conversation(): string {
    const { cfg, me } = this.s;
    const name = esc(cfg.organiser_name);
    const status = me.merged
      ? `<div class="mergebox merged">
          <div class="mb-head">⑂ Merged · <b>${esc(handleLabel(me))}</b> is in ${name}'s network</div>
          <div class="mb-stats"><span><b>${me.best}</b> 🐛 best</span><span><b>${me.rank ? `#${me.rank}` : '—'}</b> rank</span><span><b>${me.pushes}</b> push${me.pushes === 1 ? '' : 'es'}</span></div>
          <button class="bs-btn primary big" data-act="play" type="button">Push another fix</button>
          <p class="mb-hint">Only your best score counts. Replay as much as you like.</p>
        </div>`
      : `<div class="mergebox failing">
          <div class="mb-head">❌ build failing — bugs detected in <code>main.go</code></div>
          <div class="mb-check"><span class="x">✗</span> ci / bug-scan <span class="dim">— ${me.best !== null ? `your last fix: ${me.best} 🐛, not merged yet` : '23 bugs found'}</span></div>
          <div class="mb-check"><span class="ok">✓</span> ci / go-vet <span class="dim">— passed</span></div>
          <button class="bs-btn primary big" data-act="play" type="button">${me.best !== null ? 'Push another fix' : 'Fix the build'}</button>
          <p class="mb-hint">20 seconds. Tap the bugs, don't squash the features.</p>
        </div>`;
    const mergedEvent = me.merged
      ? `<div class="event"><span class="ev-dot merged">⑂</span><b>${esc(handleLabel(me))}</b> merged commit <code>${esc(me.hash)}</code> into <code>${esc(cfg.organiser_handle)}:main</code></div>`
      : '';
    return `
      <article class="comment">
        <div class="avatar" aria-hidden="true">${esc(cfg.organiser_name[0] ?? 'J')}</div>
        <div class="c-box">
          <div class="c-head"><b>${esc(cfg.organiser_handle)}</b> commented <span class="dim">· author</span></div>
          <div class="c-body">
            <p>Hey 👋 I'm ${name}. I build payment systems in Go, where one tap on <i>Pay</i> crosses half a dozen services before any money moves.</p>
            <h4>What this PR does</h4>
            <p>Adds <b>you</b> to my network.</p>
            <h4>Why CI is red</h4>
            <p>Bugs crawled into <code>main.go</code>. You get 20 seconds to squash them. Careful: the ✨ features look a lot like bugs, and squashing one costs you. <button class="linkish" data-act="play" type="button">Squash them now →</button></p>
            <h4>Checklist</h4>
            <ul class="tasks">
              ${task((me.best ?? 0) >= cfg.pass_threshold, `Fix the build: squash ${cfg.pass_threshold}+ bugs`)}
              ${task(me.merged, 'Merge: pick a handle, leave a commit message')}
              ${task(false, 'Come to the talk ↓')}
            </ul>
            <div class="talk">
              <p>🎤 <b>${esc(cfg.workshop_title)}</b><br><span class="dim">${esc(cfg.workshop_time)} · ${esc(cfg.workshop_room)}</span></p>
              <p>A payment fails. Six services touched it. Which one dropped it, and why? We'll answer that with traces, metrics and logs that point at the same request, so you stop guessing at 2am.</p>
            </div>
            <p class="links"><a href="${esc(cfg.organiser_site)}" target="_blank" rel="noopener">🌐 ${esc(cfg.organiser_site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a> · <a href="https://x.com/${esc(cfg.organiser_handle)}" target="_blank" rel="noopener noreferrer">𝕏 @${esc(cfg.organiser_handle)}</a> · <a href="${esc(cfg.organiser_linkedin)}" target="_blank" rel="noopener noreferrer">in LinkedIn</a></p>
          </div>
        </div>
      </article>
      <div class="event"><span class="ev-dot">⎇</span><b>you</b> added 1 commit <span class="dim">· bugs detected</span></div>
      ${mergedEvent}
      ${status}`;
  }

  // ------------------------------------------------------------ commits (leaderboard)

  private commits(): string {
    const { cfg, board } = this.s;
    if (!board) return '<p class="dim pad">Loading commit history…</p>';
    if (!board.rows.length) return '<p class="dim pad">No commits yet. Be the first to fix the build.</p>';
    const rows = board.rows.map((r) => rowHtml(r, cfg.pass_threshold)).join('');
    const pinned = board.me ? `<li class="gap">⋯</li>${rowHtml(board.me, cfg.pass_threshold)}` : '';
    return `
      <div class="commits-head">Commits on <code>${esc(cfg.organiser_handle)}:main</code> · ranked by best score</div>
      <ol class="commits">${rows}${pinned}</ol>
      <p class="dim small pad">Updates every 10 s.</p>`;
  }

  // ------------------------------------------------------------ checks

  private checks(): string {
    const { cfg, me } = this.s;
    const fixed = me.merged && me.best >= cfg.pass_threshold;
    const stats = me.merged
      ? `<div class="stats"><div><b>${me.best}</b><span>best score</span></div><div><b>${me.pushes}</b><span>pushes</span></div><div><b>${me.rank ? `#${me.rank}` : '—'}</b><span>rank</span></div></div>`
      : me.best !== null
        ? `<div class="stats"><div><b>${me.best}</b><span>best score</span></div><div><b>${me.pushes}</b><span>pushes</span></div><div><b>—</b><span>merge to rank</span></div></div>`
        : '<p class="dim">No pushes yet.</p>';
    const settings = me.merged ? this.settings(me) : '';
    return `
      <div class="ci">
        <div class="ci-row ok">✓ <b>go vet ./...</b><span>0.4s</span></div>
        <div class="ci-row ok">✓ <b>golangci-lint run</b><span>1.2s</span></div>
        <div class="ci-row ok">✓ <b>go test -race</b><span>3.1s</span></div>
        ${fixed
          ? `<div class="ci-row ok">✓ <b>bug-scan</b><span>0 found · fixed by ${esc(handleLabel(me))}</span></div>`
          : '<div class="ci-row bad">✗ <b>bug-scan</b><span>23 found</span></div>'}
      </div>
      <pre class="log">${fixed
        ? '$ bug-scan ./...\nscanning main.go… clean\nok   network   0.42s'
        : '$ bug-scan ./...\nmain.go:18: you not found in network\nmain.go:27: 22 more bugs crawling\nFAIL network 0.42s'}</pre>
      <h3 class="h3">Your stats</h3>
      ${stats}
      ${settings}`;
  }

  private settings(me: Extract<Me, { merged: true }>): string {
    const edit = this.editing
      ? `<form class="edit" data-form="edit">
          <textarea name="msg" rows="3" maxlength="72" autocapitalize="off" spellcheck="false" enterkeyhint="done">${esc(me.commit_message)}</textarea>
          <div class="row"><button class="bs-btn primary" type="submit">Save</button><button class="bs-btn" type="button" data-act="cancel-edit">Cancel</button></div>
          <p class="err" data-err></p>
        </form>`
      : `<p class="small">Commit message: <code>${esc(me.commit_message)}</code> <button class="linkish" data-act="edit" type="button">edit</button></p>`;
    return `
      <details class="settings">
        <summary>Settings</summary>
        ${edit}
        <p class="small">Signed in on this device as <b>${esc(me.name)}</b> (${esc(handleLabel(me))}).</p>
        <button class="bs-btn danger" data-act="delete" type="button">${this.confirmDelete ? 'Tap again to delete everything' : 'Delete my data'}</button>
        <p class="small dim">Removes your name, handle, commit and all your runs. <a href="/privacy">Privacy</a></p>
        <p class="small dim">Device code: <code>${esc(deviceToken().slice(0, 8))}</code> (to move to a new phone, show this to ${esc(this.s.cfg.organiser_name)})</p>
      </details>`;
  }

  // ------------------------------------------------------------ events

  private onClick = async (e: Event) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-tab]');
    if (!t) return;
    if (t.dataset.tab) return this.setTab(t.dataset.tab as Tab);
    switch (t.dataset.act) {
      case 'play': return this.onPlay();
      case 'edit': this.editing = true; this.render(); this.openSettings(); this.bindEdit(); return;
      case 'cancel-edit': this.editing = false; this.render(); this.openSettings(); return;
      case 'delete':
        if (!this.confirmDelete) { this.confirmDelete = true; this.render(); this.openSettings(); return; }
        await api.deleteMe();
        this.confirmDelete = false;
        this.tab = 'conversation';
        history.replaceState(null, '', location.pathname);
        this.onChanged();
        return;
    }
  };

  private openSettings() {
    const d = this.root.querySelector('details.settings') as HTMLDetailsElement | null;
    if (d) d.open = true;
  }

  private bindEdit() {
    const f = this.root.querySelector<HTMLFormElement>('[data-form=edit]');
    if (!f) return;
    const input = f.querySelector('textarea')!;
    oneLine(input);
    input.focus();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        await api.patchMe({ commit_message: input.value });
        this.editing = false;
        this.onChanged();
      } catch (x) {
        f.querySelector('[data-err]')!.textContent = x instanceof ApiError ? x.message : 'Could not save. Try again?';
      }
    };
  }
}

function tabBtn(id: Tab, label: string, count: string, cur: Tab) {
  return `<button class="tab${cur === id ? ' on' : ''}" role="tab" aria-selected="${cur === id}" data-tab="${id}" type="button">${label}${count ? ` <span class="count">${esc(count)}</span>` : ''}</button>`;
}

function task(done: boolean, label: string) {
  return `<li class="${done ? 'done' : ''}"><span class="box" aria-hidden="true">${done ? '✓' : ''}</span>${label}<span class="sr">${done ? ' (done)' : ''}</span></li>`;
}

function tabFromHash(): Tab {
  const h = location.hash.slice(1);
  return h === 'commits' || h === 'checks' ? h : 'conversation';
}
