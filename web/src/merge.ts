// First merge: name, handle, commit message, consent → Approve & Merge.
import { ApiError, api, deviceToken, type Me } from './api.ts';
import { COMMIT_SUGGESTIONS, esc, pick } from './copy.ts';
import { normalizeHandle, type HandleType } from './handle.ts';
import { rowHtml } from './rows.ts';

interface Opts {
  score: number;
  runId: string;
  pushes: number;
  passThreshold: number;
}

/** Resolves with the new profile after merging, or null if they chose "not now". */
/** A commit message is one line: a roomy box that wraps, but Enter/paste can't add newlines. */
export function oneLine(ta: HTMLTextAreaElement) {
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ta.blur(); } });
  ta.addEventListener('input', () => {
    if (/[\r\n]/.test(ta.value)) {
      const at = ta.selectionStart;
      ta.value = ta.value.replace(/[\r\n]+/g, ' ');
      ta.setSelectionRange(at, at);
    }
  });
}

export function showMergeForm(el: HTMLElement, o: Opts): Promise<Me | null> {
  return new Promise((resolve) => {
    let type: HandleType = 'x';
    let msg = pick(COMMIT_SUGGESTIONS);
    el.innerHTML = `
      <form class="bs-card merge" novalidate>
        <p class="m-kicker">You scored <b>${o.score}</b>. Sign your commit to land it in history.</p>
        <h2>Approve &amp; Merge</h2>
        <label class="fld"><span>Name</span>
          <input name="name" maxlength="40" autocomplete="name" placeholder="Ada Lovelace" required />
        </label>
        <div class="fld"><span>Handle</span>
          <div class="seg" role="radiogroup" aria-label="Handle type">
            <button type="button" role="radio" data-t="x" aria-checked="true">X</button>
            <button type="button" role="radio" data-t="linkedin" aria-checked="false">LinkedIn</button>
          </div>
          <input name="handle" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="@you or a profile URL" required />
          <small class="hint" data-hint></small>
        </div>
        <label class="fld"><span>Commit message <i data-count></i></span>
          <div class="msg-wrap">
            <textarea name="msg" rows="3" maxlength="72" autocapitalize="off" spellcheck="false" enterkeyhint="done" required>${esc(msg)}</textarea>
            <button type="button" class="dice" data-dice aria-label="Suggest another message">🎲</button>
          </div>
        </label>
        <ul class="commits" data-preview></ul>
        <label class="consent"><input type="checkbox" name="consent" />
          <span>My name, handle, score and commit message will be shown on a public leaderboard at DevFest Ilorin.</span></label>
        <p class="err" data-err role="alert"></p>
        <button class="bs-btn merge-btn" type="submit">Approve &amp; Merge</button>
        <button class="linkish" type="button" data-skip>not now, just show my score</button>
      </form>`;
    el.hidden = false;

    const f = el.querySelector('form')!;
    const $ = <T extends Element>(s: string) => f.querySelector(s) as T;
    const name = $<HTMLInputElement>('[name=name]');
    const handle = $<HTMLInputElement>('[name=handle]');
    const msgIn = $<HTMLTextAreaElement>('[name=msg]');
    oneLine(msgIn);
    const consent = $<HTMLInputElement>('[name=consent]');
    const err = $<HTMLElement>('[data-err]');
    const hint = $<HTMLElement>('[data-hint]');
    const btn = $<HTMLButtonElement>('.merge-btn');

    const paint = () => {
      const h = normalizeHandle(handle.value, type);
      hint.textContent = !handle.value.trim() ? (type === 'x' ? 'e.g. @tunde_dev or x.com/tunde_dev' : 'e.g. linkedin.com/in/your-name')
        : h ? `✓ ${h.type === 'x' ? 'X' : 'LinkedIn'}: ${h.type === 'x' ? '@' : 'in/'}${h.handle}` : '✗ not a valid handle yet';
      hint.className = `hint${handle.value.trim() ? (h ? ' ok' : ' bad') : ''}`;
      if (h && h.type !== type) setType(h.type, false);
      $<HTMLElement>('[data-count]').textContent = `${msgIn.value.length}/72`;
      $<HTMLElement>('[data-preview]').innerHTML = rowHtml({
        rank: 0, hash: 'you0000'.slice(0, 7), name: name.value.trim() || 'You',
        handle_type: h?.type ?? type, handle: h?.handle ?? 'you',
        commit_message: msgIn.value.trim(), best: o.score, pushes: o.pushes, merged_at: 0, me: true,
      }, o.passThreshold, { preview: true });
    };
    const setType = (t: HandleType, repaint = true) => {
      type = t;
      f.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === t)));
      handle.placeholder = t === 'x' ? '@you or x.com/you' : 'linkedin.com/in/you';
      if (repaint) paint();
    };
    f.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => (b.onclick = () => setType(b.dataset.t as HandleType)));
    $<HTMLButtonElement>('[data-dice]').onclick = () => {
      let next = msg;
      while (next === msg) next = pick(COMMIT_SUGGESTIONS);
      msg = next;
      msgIn.value = msg;
      paint();
    };
    f.addEventListener('input', paint);
    $<HTMLButtonElement>('[data-skip]').onclick = () => resolve(null);
    paint();

    f.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      const h = normalizeHandle(handle.value, type);
      const problem =
        name.value.trim().length < 2 ? 'Name needs at least 2 characters.'
        : !h ? 'That handle doesn’t look right. Try @handle or paste your profile URL.'
        : !msgIn.value.trim() ? 'Write a commit message (max 72 chars).'
        : !consent.checked ? 'Tick the box so your row can be shown on the leaderboard.'
        : '';
      if (problem) { err.textContent = problem; return; }
      btn.disabled = true;
      btn.textContent = 'Merging…';
      try {
        const me = await api.merge({
          name: name.value.trim(), handle: handle.value, handle_type: type,
          commit_message: msgIn.value.trim(), consent: true, run_id: o.runId,
        });
        await mergedAnimation(el, me);
        resolve(me);
      } catch (x) {
        err.textContent = x instanceof ApiError ? x.message : 'Network hiccup. Try again?';
        if (x instanceof ApiError && x.code === 'handle_taken') err.textContent += ` Your device code: ${deviceToken().slice(0, 8)}`;
        btn.disabled = false;
        btn.textContent = 'Approve & Merge';
      }
    };
  });
}

/** Open → Merged pill morph with a confetti of tiny bugs. */
export function mergedAnimation(el: HTMLElement, me: Me): Promise<void> {
  const who = me.merged ? (me.handle_type === 'x' ? `@${me.handle}` : `in/${me.handle}`) : 'you';
  el.innerHTML = `
    <div class="merged-anim" aria-live="polite">
      <span class="pill open big" data-pill>⑂ Open</span>
      <p><b>${esc(who)}</b> merged 1 commit into <code>jemeel:main</code></p>
      <div class="confetti" aria-hidden="true"></div>
    </div>`;
  const conf = el.querySelector('.confetti')!;
  const bits = ['🐛', '🐞', '🪲', '✨', '🟣'];
  for (let i = 0; i < 26; i++) {
    const s = document.createElement('span');
    s.textContent = bits[i % bits.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.animationDelay = `${Math.random() * 0.35}s`;
    s.style.setProperty('--dx', `${(Math.random() * 2 - 1) * 60}px`);
    s.style.setProperty('--r', `${(Math.random() * 2 - 1) * 540}deg`);
    conf.appendChild(s);
  }
  if ('vibrate' in navigator) try { navigator.vibrate([15, 40, 25]); } catch { /* ignore */ }
  const pill = el.querySelector<HTMLElement>('[data-pill]')!;
  setTimeout(() => {
    pill.className = 'pill merged big pop';
    pill.textContent = '⑂ Merged';
  }, 250);
  return new Promise((r) => setTimeout(r, 1900));
}
