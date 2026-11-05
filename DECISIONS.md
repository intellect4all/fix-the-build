# Design notes

Why things are the way they are. Read this before changing the game rules, the scoring, or the server checks.

## Layout and tooling
- **Frontend:** Vite + TypeScript, no framework. The Vite root is `web/` and the build lands in `web/dist/`, which a tiny `web` Go package embeds (`//go:embed` can't reach `../`).
- **Fonts:** none, only system stacks, so every page stays far under the 120 KB gzipped budget (`npm run size`; about 39 KB for all pages together).
- **Pure game logic** lives in `web/src/game/{config,rng,schedule,score}.ts` with no DOM, so it's unit-testable and portable. `web/src/game.ts` only renders and handles input.
- **Backend:** Go standard library HTTP, `modernc.org/sqlite` (pure Go, no cgo), one static binary with the frontend embedded. The module stays on `go 1.23`, which is why sqlite is pinned to v1.38.2.

## Determinism
- **Seeded schedule:** each run's `seed` feeds mulberry32, which builds the **whole spawn schedule up front** (`buildSchedule`). Nothing else draws from the seeded stream: wander, particles and shake use `Math.random`, so frame rate and tapping can't shift the sequence.
- **On-screen caps:** at most 1 golden and 2 features on screen at once. These caps depend on play, so they're enforced at spawn time by swapping in a plain bug. The schedule itself depends only on the seed.
- **Golden limit:** the schedule allows at most 2 goldens per round, at least 1.7 s apart, to keep score variance down.
- **Ported to Go** (`internal/game`) bit for bit. `npm run fixture` writes `internal/game/testdata/fixture.json` from the real TypeScript code:
  - mulberry32 draws;
  - the first spawns of a seed;
  - per-kind counts for 1,004 seeds;
  - 3,000 simulated honest runs.

  The Go tests require exact equality, and require that no honest run is ever flagged. Re-run the fixture after touching `config.ts`, and mirror the change in `internal/game/config.go`.
- **FMA:** Go may fuse `a*b+c` into one instruction on arm64, and JavaScript never does. The schedule maths wraps products in `float64(...)` to force the same rounding. The parity tests pass on both arm64 and amd64.

## Scoring
- **Bug:** +1 × the combo multiplier, counting the current hit: hits 1–4 are ×1, 5–9 are ×2, 10+ are ×3.
- **Golden bug:** a flat +5 (not multiplied). It counts as a hit, so it extends the combo.
- **Feature:** −3 and resets the combo. The score never goes below 0.
- **Armored bugs** need two taps. The first tap scores nothing, knocks the bug sideways, and keeps the combo alive without adding to it. The kill scores like a normal bug.
- **No score cap:** a great honest player scores as high as they can. Integrity comes from the checks below, not from a ceiling.
- **Round time** accumulates `min(dt, 50 ms)` and freezes while paused, so game time never runs faster than wall time.

## Tuning
The first draft (1.2 → 3.5 spawns/s, slow bugs) scored far too high in simulation. The current tuning came out of phone play-tests, where people asked for "more bugs, from different directions, getting harder to kill":

| config | casual | good | expert | perfect bot |
|---|---|---|---|---|
| first draft (1.2→3.5/s, slow bugs) | 22 | 84 | 121 | 173 |
| **current** (1.0→3.0/s, 4 edges, evasion, armor) | 17 | 55 | 88 | 139 |

Medians over 1,000 seeds from `npm run sim`. The player models are guesses at human tap rate and accuracy.

- **Spawn rate** ramps from 1.0/s to 3.0/s, with swarms of 5–7 at 8 s and 15 s.
- **Speed:** bugs cross the screen in about 2.9 s at the start and 1.8 s at the end. Speed is a fraction of the playfield width, so a phone and a laptop play the same.
- **Entry edges:** left 40 % (crawling out of the code), right 25 %, top 15 %, bottom 20 %. The edge is part of the seeded schedule.
- **Evasion** ramps from 0 at 4 s to full at 20 s:
  - a missed tap within 110 px can make nearby bugs jink away (goldens always dodge);
  - bugs also dart sideways at random.

  Evasion is runtime randomness, not seeded, so it doesn't affect verification.
- **Armor:** the chance of an armored bug ramps from 0 at 6 s to 35 % at the end, and is seeded.
- **Comparing:** `/play-test/?preset=classic` plays the calmer first-draft density, for side-by-side feel tests.

## Touch and feel
- **Playfield:** capped at 540 px wide on desktop, so it plays like a phone.
- **Hit areas:** the hit radius is 30 CSS px. Features use a box matching their wider label.
- **Taps:** taps on empty space are counted, for the taps check, and do nothing else.
- **Sound:** off by default. The AudioContext is created only on a user gesture, which iOS requires.
- **Hidden tab:** a round that starts in a hidden tab begins paused ("tap to resume").

## PR page
- **Device token:** a UUID in localStorage plus a one-year `ftb_device` cookie. It falls back to `getRandomValues` because `crypto.randomUUID` doesn't exist on plain-HTTP LAN addresses.
- **Handles** have an X / LinkedIn toggle, and a pasted profile URL flips it automatically. Handles are stored lower-case.
  - X: `[a-z0-9_]{1,15}`, shown as `@handle`.
  - LinkedIn: the `/in/<slug>` part, shown as `in/slug`.
- **Flow:** game, then (first time only) the merge form, the Merged animation, and results. "Not now" keeps the run on the device, and it attaches when the player merges later.
- **Polling:** the leaderboard re-renders only when the Commits tab is showing and the data changed, so an open form is never wiped.
- **Delete my data** uses a two-tap in-page confirm (no `window.confirm`).
- **Theme:** the PR page follows the system light/dark setting. The game, merge form and results stay dark, like a code editor.
- **Commit message:** a 3-row textarea, so the whole message is visible. It's still a single line: Enter closes the keyboard, and pasted newlines become spaces (the server collapses them too).
- **Merge sheet layout:** a grid with `grid-template-columns: minmax(0, 1fr)`. An `auto` column grew to its content and overflowed 360 px screens.

## Server checks
A run that fails a check is **flagged silently**: the response looks normal, but the run never reaches the board. The checks:
- 19 s to 10 min elapsed, on the server clock;
- the score recomputes exactly from the per-tier counts (`bugs_x1/x2/x3`), and `bugs == x1+x2+x3`;
- `taps ≤ 400` and `taps ≥ hits` (fast two-thumb players pass 200; the client reports taps, so this is a sanity bound, not real protection);
- `max_combo ≤ hits`, and ×2 or ×3 bugs need `max_combo` of at least 5 or 10;
- goldens and features no more than the schedule spawned, and all hits no more than total spawns.
  - The on-screen caps turn scheduled goldens and features into plain bugs, so the bug supply is *all* spawns. A tighter bound would flag honest players who avoid features.

Two related rules:
- **A second finish** for the same run returns the stored result and changes nothing. It's almost always a retry after a lost response on mobile data, so it isn't flagged.
- **Unknown run ids** get a real 404.

## Data
- **SQLite:**
  - WAL mode, `busy_timeout=5000`, foreign keys and `synchronous=NORMAL`, all set in the DSN so they apply to every connection;
  - a single connection, since writes serialise anyway and every query is sub-millisecond at this scale;
  - migrations tracked with `PRAGMA user_version`;
  - all times stored as Unix milliseconds.
- **Commit hash:** `sha256(fmt.Sprintf("%d%d", player_id, created_at_ms))[:7]`.
- **Ranking:**
  - best = the highest finished, unflagged score;
  - ties go to whoever reached that score first, then the lowest player id;
  - hidden players are excluded;
  - the full ranking is cached for 2 s and invalidated on every write, so a new player sees their row at once.
- **Text:** names (2–40 characters) and commit messages (1–72) are counted in runes, not bytes, and control characters collapse to spaces.

## Limits and privacy
- **Rate limits** are kept in memory, which is fine for a one-day event:
  - starting runs: 1 per 5 s per device;
  - merging: 5 per hour per device, counted only once the form validates, so typos don't lock anyone out;
  - per-IP backstop: `IP_LIMIT`, default 1200/min, on `/api/me`, `/api/runs*` and `/api/merge`.

  A whole venue shares one NAT IP, and a workshop rush comes to about 600 counted requests a minute. The polling endpoints and static files are exempt for the same reason.
- **Client IPs:** with `TRUST_PROXY=1`, the app reads the last `X-Forwarded-For` hop, so the proxy in front must overwrite that header (Caddy does). Behind a CDN that proxies traffic, every player would look like the CDN's IP, so point DNS straight at the box.
- **Logging:** the request log records method, path, status and duration, never IPs or bodies. Caddy has no access log.
- **Headers:**
  - CSP `default-src 'self'` (inline styles allowed), nosniff, and no framing;
  - `/assets/*` cached as immutable, HTML not cached.
- **Retention:** the promised deletion 60 days after the event is a manual checklist step. An automated purge isn't worth the risk of deleting data by accident during the event.

## Admin and board
- **Signing in:** `POST /api/admin/login` takes the token once and sets an HttpOnly, SameSite=Strict cookie (Secure over HTTPS) for 12 hours. `X-Admin-Token` also works, for curl.
  - Login is limited to 10 tries per minute per IP, and the token is compared in constant time.
  - Admin writes must be JSON, so a cross-site form can't send them.
  - With no `ADMIN_TOKEN` set, or the default `change-me`, admin is off entirely (404).
- **Admin tools:**
  - search, hide and unhide players, and edit commit messages inline;
  - the 100 most recent flagged runs, with reasons;
  - CSV export. Cells starting with `= + - @` get a `'` prefix, against spreadsheet formula injection.
- **New phone, same person:**
  1. They play one round on the new phone.
  2. The merge fails and shows their 8-character device code.
  3. In admin, **Link phone** on their row attaches that device and its runs to them.
- **/board:**
  - Polls `/api/stats` every 5 s.
  - Rows are keyed by commit hash with FLIP animation: moved rows slide, a new best flashes, and new rows slide in.
  - The QR code (`qrcode-generator`, board page only) points at `BASE_URL`.
  - Portrait screens fall back to a stacked layout.

## Shipping
- **Backups** are built into the binary rather than a cron sidecar:
  - Every `BACKUP_EVERY` the server runs `VACUUM INTO` a temp file and then renames it.
  - It keeps `BACKUP_KEEP` files and hard-links `game-latest.db` to the newest.
  - It takes one snapshot at start and a final one on SIGTERM.
  - The backup shares the app's connection, so it can never capture a half-written transaction.
- **Off-site copies** are optional: an rclone sidecar under the `offsite` compose profile.
- **Image:**
  - Node build and test, then Go vet, test and build on the target platform, so the TS↔Go parity test runs on the architecture you deploy to.
  - The runtime is `alpine` as non-root uid 10001. Alpine rather than distroless so the healthcheck can `wget /healthz`, which also pings the database.
  - `GOTOOLCHAIN=local` makes the build fail loudly rather than download a newer Go.
- **Hosts:**
  - **Own box:** `deploy/docker-compose.yml` runs the app plus Caddy (automatic HTTPS, compression, HSTS).
  - **Shared box:** `deploy/docker-compose.shared.yml` runs the app alone on loopback (256 MB, 1 CPU) for a box that already has a reverse proxy. That box can load an image built elsewhere instead of building it itself.
- **Load test:** a Go program (`cmd/loadtest`) rather than k6, so there's nothing extra to install and it can build valid runs from the real schedule code. It spreads players over fake client IPs, so the per-IP backstop doesn't treat the test machine as one venue.
- **Measured** on a small x86_64 box behind Caddy:
  - 300 players × 5 games over 30 min: 0 errors, 0 flagged runs, highest p95 27 ms;
  - 100 players arriving in one minute from one IP: every p95 under 10 ms;
  - about 9 MB of RAM for the app;
  - a backup restore drill came back with every row.
