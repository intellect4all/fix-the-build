// Handle normalisation. Mirrored by the Go server (internal/api/handle.go).
// Accepts "@handle", "handle", or an X / LinkedIn profile URL.
export type HandleType = 'x' | 'linkedin';
export interface Handle { type: HandleType; handle: string }

const X_RE = /^[a-z0-9_]{1,15}$/;
const LI_RE = /^[a-z0-9][a-z0-9_-]{1,99}$/;

/** `fallback` is the type picked in the form, used when the input isn't a URL. */
export function normalizeHandle(input: string, fallback: HandleType): Handle | null {
  let s = input.trim();
  if (!s) return null;

  const url = s.match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.|mobile\.)?(x\.com|twitter\.com|linkedin\.com)\/(.*)$/i);
  if (url) {
    const host = url[1].toLowerCase();
    const path = url[2].split(/[?#]/)[0].replace(/\/+$/, '');
    if (host === 'linkedin.com') {
      const m = path.match(/^(?:in|pub)\/([^/]+)/i);
      if (!m) return null;
      let slug = m[1];
      try { slug = decodeURIComponent(slug); } catch { /* keep raw */ }
      slug = slug.toLowerCase();
      return LI_RE.test(slug) ? { type: 'linkedin', handle: slug } : null;
    }
    const h = path.split('/')[0].replace(/^@/, '').toLowerCase();
    return X_RE.test(h) ? { type: 'x', handle: h } : null;
  }

  s = s.replace(/^@/, '').toLowerCase();
  if (fallback === 'linkedin') return LI_RE.test(s) ? { type: 'linkedin', handle: s } : null;
  return X_RE.test(s) ? { type: 'x', handle: s } : null;
}

export function profileUrl(h: Handle): string {
  return h.type === 'x' ? `https://x.com/${h.handle}` : `https://www.linkedin.com/in/${h.handle}`;
}
