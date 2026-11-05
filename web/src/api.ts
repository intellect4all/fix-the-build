// API client. Shapes match the JSON API served by the Go server (internal/api).
import type { HandleType } from './handle.ts';

// ---------------------------------------------------------------- types

export interface Config {
  event_name: string;
  organiser_name: string;
  organiser_handle: string; // X handle, also the fake GitHub owner
  organiser_linkedin: string; // full profile URL
  organiser_site: string; // portfolio URL
  workshop_title: string;
  workshop_time: string;
  workshop_room: string;
  pass_threshold: number;
  base_url: string;
}

export type Me =
  | { merged: false; best: number | null; pushes: number }
  | {
      merged: true;
      name: string;
      handle_type: HandleType;
      handle: string;
      commit_message: string;
      hash: string;
      best: number;
      pushes: number;
      rank: number;
    };

export interface RunStart { run_id: string; seed: number; started_at: number }

export interface FinishBody {
  bugs: number;
  bugs_x1: number;
  bugs_x2: number;
  bugs_x3: number;
  golden: number;
  features_hit: number;
  max_combo: number;
  taps: number;
  score: number;
}

export interface FinishResp {
  score: number;
  best: number;
  is_new_best: boolean;
  rank: number | null; // null until merged
  passed_player?: string; // handle of someone they just overtook
}

export interface MergeBody {
  name: string;
  handle: string; // raw input; the server normalises
  handle_type: HandleType; // form toggle, used when the handle isn't a URL
  commit_message: string;
  consent: boolean;
  run_id: string;
}

export interface Row {
  rank: number;
  hash: string;
  name: string;
  handle_type: HandleType;
  handle: string;
  commit_message: string;
  best: number;
  pushes: number;
  merged_at: number;
  me?: boolean;
}

export interface Leaderboard { rows: Row[]; me: Row | null; total_players: number }

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface Api {
  config(): Promise<Config>;
  me(): Promise<Me>;
  startRun(): Promise<RunStart>;
  finishRun(id: string, body: FinishBody): Promise<FinishResp>;
  merge(body: MergeBody): Promise<Me>;
  patchMe(body: { commit_message: string }): Promise<Me>;
  deleteMe(): Promise<void>;
  leaderboard(limit?: number): Promise<Leaderboard>;
}

// ---------------------------------------------------------------- device token

function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // crypto.randomUUID needs a secure context (missing on http://<lan-ip>); getRandomValues doesn't.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const TOKEN_KEY = 'ftb.device';
export function deviceToken(): string {
  let t: string | null = null;
  try { t = localStorage.getItem(TOKEN_KEY); } catch { /* blocked storage */ }
  if (!t) t = document.cookie.match(/(?:^|; )ftb_device=([^;]+)/)?.[1] ?? null;
  if (!t) t = uuid();
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
  document.cookie = `ftb_device=${t}; Max-Age=31536000; Path=/; SameSite=Lax`;
  return t;
}

// ---------------------------------------------------------------- HTTP implementation

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReqOpts { retries?: number; timeout?: number }

export class HttpApi implements Api {
  constructor(private device: string, private base = '') {}

  private async req<T>(method: string, path: string, body?: unknown, o: ReqOpts = {}): Promise<T> {
    const { retries = 0, timeout = 8000 } = o;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      let res: Response;
      try {
        res = await fetch(this.base + path, {
          method,
          headers: { 'X-Device-Token': this.device, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctl.signal,
          credentials: 'same-origin',
        });
      } catch {
        clearTimeout(timer);
        if (attempt < retries) { await sleep(800 * 2 ** attempt); continue; }
        throw new ApiError('network', 'The network is having a moment. Try again?');
      }
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) { await sleep(800 * 2 ** attempt); continue; }
      if (res.status === 204) return undefined as T;
      let data: any = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) {
        const e = data?.error;
        throw new ApiError(e?.code ?? `http_${res.status}`, e?.message ?? 'Something went wrong. Try again?');
      }
      return data as T;
    }
  }

  config() { return this.req<Config>('GET', '/api/config', undefined, { retries: 2 }); }
  me() { return this.req<Me>('GET', '/api/me', undefined, { retries: 2 }); }
  startRun() { return this.req<RunStart>('POST', '/api/runs'); }
  // Retried: a finish whose response got lost is answered from the stored run.
  finishRun(id: string, body: FinishBody) {
    return this.req<FinishResp>('POST', `/api/runs/${encodeURIComponent(id)}/finish`, body, { retries: 2 });
  }
  merge(body: MergeBody) { return this.req<Me>('POST', '/api/merge', body, { timeout: 12000 }); }
  patchMe(body: { commit_message: string }) { return this.req<Me>('PATCH', '/api/me', body); }
  deleteMe() { return this.req<void>('DELETE', '/api/me'); }
  leaderboard(limit = 50) { return this.req<Leaderboard>('GET', `/api/leaderboard?limit=${limit}`, undefined, { retries: 1 }); }
}

export const api: Api = new HttpApi(deviceToken());
