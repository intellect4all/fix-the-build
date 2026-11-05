# Fix the Build

I gave a workshop at DevFest Ilorin 2026 and wanted something better than "scan to follow me" on my shirt. So the QR code opens a GitHub pull request called *Add you to my network*, and its build is failing. To fix it you play Bug Swarm: 20 seconds of tapping bugs as they crawl out of `main.go`, without squashing the features. Your score lands as a commit in the history, and the history doubles as the leaderboard on the projector.

It's live at https://pr.jemeel.dev.

## How it's put together

The frontend is plain TypeScript built with Vite, and the game draws on a canvas. The backend is a Go server using only the standard library, with SQLite (pure Go, no cgo). The frontend is embedded in the binary, so one ~26 MB container is the whole app.

The fun part is score checking. Every round gets a seed from the server, and the seed drives a precomputed spawn schedule. The server has a Go port of that schedule and rebuilds it, so it knows exactly how many bugs, golden bugs and features that round could have produced. It then recomputes the score from the counts the client sends. To keep the two implementations honest, a test fixture generated from the TypeScript code has to match the Go code bit for bit. Forged scores get flagged quietly and never reach the board.

[DECISIONS.md](DECISIONS.md) explains the reasoning behind the rules, tuning and limits.

## Running it locally

You need Node 20+ and Go 1.23+.

```sh
npm install
npm run serve        # builds the frontend, starts the server on :8080
```

Open `http://<your-lan-ip>:8080` on your phone (same Wi-Fi) to play the full flow, or `/play-test/` for just the game. Two phones give you two players on the same history. For frontend work with hot reload, run `go run ./cmd/server` and `npm run dev` side by side; Vite proxies `/api` to the Go server.

Other useful commands:

```sh
npm test             # frontend tests
go test ./...        # server tests, including the TS/Go parity check
npm run fixture      # regenerate the parity fixture after changing web/src/game/config.ts
npm run sim          # simulate players to see what scores a config produces
npm run size         # gzipped page sizes
```

The pages are `/` (the PR), `/board` (projector view), `/admin`, `/privacy` and `/play-test/`. Admin needs `ADMIN_TOKEN` set. All the settings are environment variables, and [deploy/.env.example](deploy/.env.example) lists the main ones.

## Deploying

Any small Linux box with Docker works; 1 vCPU and 1 GB is plenty for a few hundred players. Point an `A` record at it, then:

```sh
cp deploy/.env.example deploy/.env     # set DOMAIN, BASE_URL and ADMIN_TOKEN (openssl rand -hex 24)
docker compose -f deploy/docker-compose.yml up -d --build
```

That runs the app behind Caddy, which handles HTTPS. The image build runs all the tests and won't produce an image if any fail. Keep the DNS record unproxied (no CDN in front), or every player shows up with the CDN's IP and the per-IP limit stops making sense. Changing settings like the workshop time or room only needs `up -d`, not a rebuild.

If the box already runs a reverse proxy, use `deploy/docker-compose.shared.yml` instead. It starts just the app on `127.0.0.1:38180`, and you point your existing proxy at that.

To try it on a LAN without a domain, set `DOMAIN=:80` and `BASE_URL=http://<host-ip>`.

## Backups

The server snapshots the database every 5 minutes with `VACUUM INTO`, keeps a day of snapshots, and takes one more on shutdown. To grab the latest one:

```sh
docker compose -f deploy/docker-compose.yml cp app:/backups/game-latest.db ./game-backup.db
```

To restore it:

```sh
C="docker compose -f deploy/docker-compose.yml"
$C stop app
$C run --rm --no-deps -u 0 --entrypoint sh -v "$PWD/game-backup.db:/restore.db:ro" app \
  -c 'cp /restore.db /data/game.db && rm -f /data/game.db-wal /data/game.db-shm && chown app:app /data/game.db'
$C start app
```

For off-site copies, put an `rclone.conf` in `deploy/`, set `RCLONE_DEST`, and start the `offsite` profile.

## Load testing

```sh
go run ./cmd/loadtest -url https://your-domain -players 300 -games 5 -ramp 30m
```

The simulated players behave like the real page: they poll the leaderboard, play valid rounds, and merge after their first game. It fails if any endpoint's p95 goes over 200 ms. On a small VPS, 300 players doing 5 games each peaked around 27 ms.

## On the day

Before the event, play a round on two phones and watch both show up on `/board`. Also scan the shirt QR from a couple of metres away. During the workshop, `/board` stays full-screen on the laptop. If someone writes something they shouldn't, `/admin` can edit or hide their commit. If someone switches phones, they play once on the new one and read you the device code from the error, and **Link phone** in admin moves them over. Afterwards, export the CSV. The privacy page promises deletion 60 days after the event, so run `down -v` then, and clear any off-site copies.

## Built with Claude

I built this with [Claude Code](https://claude.com/claude-code): I came up with the idea, the rules and the look, and Claude wrote most of the code with me over a day of back-and-forth and phone testing.
