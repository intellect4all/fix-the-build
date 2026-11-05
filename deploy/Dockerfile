# Build: docker compose -f deploy/docker-compose.yml build  (context is the repo root)

# 1) Frontend: type-check, unit tests, Vite build → web/dist
FROM node:22-alpine AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY scripts ./scripts
COPY web ./web
RUN npx vitest run && npm run build

# 2) Server: tests run on the target arch (this is the amd64 TS↔Go parity check), then a static binary
FROM golang:1.23-alpine AS server
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY migrations ./migrations
COPY web/embed.go ./web/embed.go
COPY --from=web /src/web/dist ./web/dist
RUN go vet ./... && go test ./... && \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# 3) Runtime: tiny, non-root
FROM alpine:3.20
RUN adduser -D -H -u 10001 app && mkdir -p /data /backups && chown app:app /data /backups
COPY --from=server /out/server /usr/local/bin/server
USER app
ENV ADDR=:8080 DB_PATH=/data/game.db BACKUP_DIR=/backups TRUST_PROXY=1
EXPOSE 8080
VOLUME ["/data", "/backups"]
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/server"]
