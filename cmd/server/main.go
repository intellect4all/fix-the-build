// Command server runs Fix the Build: JSON API + embedded frontend, one binary.
package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"fixthebuild/internal/api"
	"fixthebuild/internal/store"
	"fixthebuild/web"
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	addr := env("ADDR", ":8080")
	dbPath := env("DB_PATH", "game.db")
	pass, err := strconv.Atoi(env("PASS_THRESHOLD", "15"))
	if err != nil {
		log.Fatalf("PASS_THRESHOLD: %v", err)
	}
	pub := api.PublicConfig{
		EventName:         env("EVENT_NAME", "DevFest Ilorin 2026"),
		OrganiserName:     env("ORGANISER_NAME", "Jemeel"),
		OrganiserHandle:   env("ORGANISER_HANDLE", "intellect4all"),
		OrganiserLinkedIn: env("ORGANISER_LINKEDIN", "https://www.linkedin.com/in/abdul-jemeel-odewole-393a0b105/"),
		OrganiserSite:     env("ORGANISER_SITE", "https://jemeel.dev"),
		WorkshopTitle:     env("WORKSHOP_TITLE", "Observability for Distributed Systems"),
		WorkshopTime:      env("WORKSHOP_TIME", "12:00 PM"),
		WorkshopRoom:      env("WORKSHOP_ROOM", "Room B"),
		PassThreshold:     pass,
		BaseURL:           env("BASE_URL", "https://pr.jemeel.dev"),
	}
	ipLimit, err := strconv.Atoi(env("IP_LIMIT", "1200"))
	if err != nil || ipLimit < 1 {
		log.Fatalf("IP_LIMIT: %v", err)
	}
	admin := env("ADMIN_TOKEN", "")
	if admin == "" || admin == "change-me" {
		log.Printf("warning: ADMIN_TOKEN is unset or default; /admin is disabled until you set it")
		admin = ""
	}

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer st.Close()

	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		log.Fatalf("frontend not built: run `npm run build` before `go build`")
	}

	srv := api.New(st, api.Options{
		Public:     pub,
		AdminToken: admin,
		TrustProxy: env("TRUST_PROXY", "0") == "1",
		IPLimit:    ipLimit,
		Static:     dist,
	})

	hs := &http.Server{
		Addr:              addr,
		Handler:           api.Middleware(srv),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	backupDone := make(chan struct{})
	if dir := env("BACKUP_DIR", ""); dir != "" {
		every, err := time.ParseDuration(env("BACKUP_EVERY", "5m"))
		if err != nil || every < time.Second {
			log.Fatalf("BACKUP_EVERY: bad duration %q", env("BACKUP_EVERY", "5m"))
		}
		keep, err := strconv.Atoi(env("BACKUP_KEEP", "288")) // 24 h at 5 min
		if err != nil || keep < 1 {
			log.Fatalf("BACKUP_KEEP: %v", err)
		}
		log.Printf("backups: every %s into %s, keeping %d", every, dir, keep)
		go func() { st.BackupLoop(ctx, dir, every, keep); close(backupDone) }()
	} else {
		log.Printf("backups: off (set BACKUP_DIR)")
		close(backupDone)
	}
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				srv.GC()
			}
		}
	}()
	go func() {
		log.Printf("listening on %s (db %s)", addr, dbPath)
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	log.Printf("shutting down")
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = hs.Shutdown(sctx)
	<-backupDone // final snapshot before the DB closes
}
