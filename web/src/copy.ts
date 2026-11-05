// Player-facing copy. Playful, short, never mean.
export const COMMIT_SUGGESTIONS = [
  'fix: squashed bugs, saved prod',
  "feat: add a frontend dev to Jemeel's network",
  'feat: a designer has entered the chat',
  'chore: merged on a Friday, no regrets',
  'fix: it works on my machine',
  'refactor: removed bugs, added vibes',
  'docs: wrote zero docs, fixed everything',
  'perf: reduced bugs by 100% (citation needed)',
  'test: tested in production',
  'feat: networking at DevFest Ilorin',
];
export const PASS_LINES = ['All checks green. Ship it.', 'LGTM 🚀', 'Clean build. Senior engineer energy.'];
export const FAIL_LINES = ['Merged with failing checks. Bold.', 'It compiles. Probably.', 'Approved by vibes.'];
export const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
