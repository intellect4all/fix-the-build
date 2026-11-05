# Fix the Build — DevFest Ilorin 2026

A mobile web game behind a QR code, built for my workshop at DevFest Ilorin 2026. Scanning it opens a fake GitHub pull request whose build is failing. Fixing it means playing **Bug Swarm**, a 20-second tap game. Your score lands in a leaderboard styled as a commit history, which runs live on the projector.

Live at https://pr.jemeel.dev. Design notes are in [DECISIONS.md](DECISIONS.md).

## Develop
Needs Node 20+ and Go 1.23+.
```sh
npm install
npm run serve     # build frontend, then run the Go server on :8080 (DB: ./game.db)
npm test          # frontend unit tests
go test ./...     # server: score validation, TS↔Go parity, full API flow
npm run fixture   # regenerate TS→Go parity data after changing web/src/game/config.ts
npm run sim       # headless score-tuning simulation
npm run size      # build + gzipped size report (budget 120 KB)
```
Hot-reload frontend work: `go run ./cmd/server` in one terminal, `npm run dev` in another (Vite proxies `/api` to :8080).

### Try it on your phone
1. `npm run serve` (or `npm run build && go build -o bin/server ./cmd/server && ./bin/server`).
2. With the phone on the same Wi-Fi, open `http://<your-lan-ip>:8080/` (full flow) or `/play-test/` (game only).
   - `?seed=123` replays a fixed seed. `?fps=0` hides the FPS meter.
3. Two phones = two players on the same commit history.

### Pages
- `/`: the PR page, game and merge flow.
- `/board`: the projector leaderboard (landscape, dark, QR code, updates every 5 s).
- `/admin`: needs `ADMIN_TOKEN`. Hide players, edit messages, link a new phone, export CSV, see flagged runs.
- `/privacy`: the privacy notice.
- `/play-test/`: the game on its own.

For local dev, put `ADMIN_TOKEN` in `.env.local` (gitignored) and start the server with `set -a; . ./.env.local; set +a; ./bin/server`.

### Config (env vars)
`ADDR` (:8080), `DB_PATH` (game.db), `BASE_URL`, `ADMIN_TOKEN`, `TRUST_PROXY` (1 behind Caddy), `EVENT_NAME`, `ORGANISER_NAME`, `ORGANISER_HANDLE`, `ORGANISER_LINKEDIN`, `ORGANISER_SITE`, `WORKSHOP_TITLE`, `WORKSHOP_TIME`, `WORKSHOP_ROOM`, `PASS_THRESHOLD`, `IP_LIMIT` (per-IP backstop per minute, default 1200), `BACKUP_DIR`, `BACKUP_EVERY`, `BACKUP_KEEP`.

## Deploy (one small VPS)
You need any Linux VPS (1 vCPU / 1 GB is plenty for 500 players) with Docker and the compose plugin, plus DNS for your domain.

1. **DNS:** add an `A` record for `pr.jemeel.dev` pointing at the VPS IP, and open ports 80 and 443.
2. **Code:** `git clone … && cd fix-the-build` (or `rsync` this folder).
3. **Config:** `cp deploy/.env.example deploy/.env`, then edit it:
   - `DOMAIN` and `BASE_URL`;
   - `ADMIN_TOKEN` (`openssl rand -hex 24`);
   - the workshop time and room.
4. **Start:** `docker compose -f deploy/docker-compose.yml up -d --build`. The image build runs the frontend tests and the Go tests on the server's CPU, which includes the TS↔Go parity check. It refuses to build if any test fails.
5. **Check:** `curl https://pr.jemeel.dev/healthz` should print `ok`. Caddy gets the certificate on first request, which takes a few seconds.
6. **Logs:** `docker compose -f deploy/docker-compose.yml logs -f app`. They record requests and flagged runs, and never IPs.

**LAN or staging test without a domain:** set `DOMAIN=:80` and `BASE_URL=http://<host-ip>` in `deploy/.env`. Caddy then serves plain HTTP; the admin cookie drops `Secure` automatically.

**Shared host (a box that already runs Caddy on 80/443):** run the app only, on loopback, and add a site block to the existing proxy.
- Build the image anywhere amd64 (`docker build -f deploy/Dockerfile -t ftb-app:latest .`), then `docker save ftb-app:latest | gzip | ssh host 'gunzip | docker load'`.
- On the host: `deploy/.env` as above, then `docker compose -p ftb -f deploy/docker-compose.shared.yml up -d` (listens on `127.0.0.1:38180`).
- Host Caddyfile: `pr.jemeel.dev { encode zstd gzip; header { Strict-Transport-Security "max-age=31536000"; -Server }; reverse_proxy 127.0.0.1:38180 }`, then `caddy validate` and `systemctl reload caddy`.
- The DNS record must point straight at the box (DNS only, no CDN proxy), so Caddy can get the certificate and sees real client IPs.

**Update:** `git pull && docker compose -f deploy/docker-compose.yml up -d --build`. Data lives in the `data` volume and survives rebuilds.

### Backups
- The server snapshots the database with `VACUUM INTO` every 5 minutes into the `backups` volume. It keeps 24 h of snapshots (`BACKUP_EVERY`, `BACKUP_KEEP`) and takes a final one on shutdown. `game-latest.db` always points at the newest snapshot.
- **Copy one off the box:** `docker compose -f deploy/docker-compose.yml cp app:/backups/game-latest.db ./game-backup.db`
- **Restore** (from the repo root, with the backup at `./game-backup.db`):
  ```sh
  C="docker compose -f deploy/docker-compose.yml"
  $C stop app
  $C run --rm --no-deps -u 0 --entrypoint sh -v "$PWD/game-backup.db:/restore.db:ro" app \
    -c 'cp /restore.db /data/game.db && rm -f /data/game.db-wal /data/game.db-shm && chown app:app /data/game.db'
  $C start app
  ```
- **Off-site (object storage):** set up any rclone remote (S3, Cloudflare R2, Backblaze B2, Google Drive):
  1. Run `rclone config` on your laptop, then `cp ~/.config/rclone/rclone.conf deploy/`.
  2. Set `RCLONE_DEST=remote:bucket/path` in `deploy/.env`.
  3. Run `docker compose -f deploy/docker-compose.yml --profile offsite up -d`.
  
  It then copies new snapshots every 5 minutes.

### Load test
- **Command:** `go run ./cmd/loadtest -url https://pr.jemeel.dev -players 300 -games 5 -ramp 30m`
- **What it does:** simulates real players. Each one polls the leaderboard every 10 s, plays real 23 s rounds that the server validates, and merges after the first game. A board screen polls `/api/stats` at the same time. The run exits non-zero if any endpoint's p95 exceeds 200 ms.
- **Against a local server:** run the server with `TRUST_PROXY=1` so the fake client IPs apply.

## Day-of checklist
1. **Night before:**
   - deploy;
   - open the site on **two phones**, then play and merge on each;
   - open `/board` on the laptop and confirm both rows appear within 5 s;
   - sign in to `/admin` and download the CSV once.
2. **Shirt QR:** test it from 1–2 m in indoor light, and check it opens `https://pr.jemeel.dev`.
3. **Workshop details:** set the time and room in `deploy/.env` (`WORKSHOP_TIME`, `WORKSHOP_ROOM`), then run `docker compose -f deploy/docker-compose.yml up -d` to apply them. No rebuild is needed.
4. **At the workshop:**
   - open `/board` full-screen on the presenting laptop;
   - read out the top 3 and the funniest commit messages;
   - if a message is offensive, `/admin` → Edit msg or Hide.
5. **New phone, same person** ("handle already merged"):
   1. They play one round on the new phone.
   2. They read you the device code from the error.
   3. In `/admin`, find their row → **Link phone** → enter the code.
6. **After:**
   - `/admin` → Export CSV;
   - follow up with players;
   - post the final top 10 (screenshot `/board`).
7. **60 days after the event** (the promise on `/privacy`): delete everything, including off-site copies. Remove the containers and their data with `docker compose -f deploy/docker-compose.yml down -v`.
