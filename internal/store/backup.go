package store

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backup writes a consistent snapshot with VACUUM INTO (safe while the app
// is writing; WAL readers don't block). It writes to a temp name and renames,
// so a half-written file never looks like a backup.
func (s *Store) Backup(ctx context.Context, path string) error {
	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, tmp); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// BackupLoop snapshots the DB into dir every `every`, keeping the newest
// `keep` files (game-YYYYMMDD-HHMMSS.db), plus game-latest.db for easy restore.
// It takes a final snapshot when ctx is cancelled.
func (s *Store) BackupLoop(ctx context.Context, dir string, every time.Duration, keep int) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		log.Printf("backup: %v", err)
		return
	}
	run := func(c context.Context) {
		name := filepath.Join(dir, "game-"+time.Now().UTC().Format("20060102-150405")+".db")
		start := time.Now()
		if err := s.Backup(c, name); err != nil {
			log.Printf("backup failed: %v", err)
			return
		}
		latest := filepath.Join(dir, "game-latest.db")
		_ = os.Remove(latest)
		if err := os.Link(name, latest); err != nil {
			log.Printf("backup: latest link: %v", err)
		}
		prune(dir, keep)
		log.Printf("backup ok: %s (%s)", filepath.Base(name), time.Since(start).Round(time.Millisecond))
	}
	run(ctx)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			run(c)
			cancel()
			return
		case <-t.C:
			run(ctx)
		}
	}
}

func prune(dir string, keep int) {
	m, _ := filepath.Glob(filepath.Join(dir, "game-2*.db"))
	sort.Strings(m) // timestamped names sort chronologically
	for len(m) > keep {
		if err := os.Remove(m[0]); err != nil && !strings.Contains(err.Error(), "no such file") {
			log.Printf("backup prune: %v", fmt.Sprint(err))
		}
		m = m[1:]
	}
}
