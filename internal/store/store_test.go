package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPragmasAndMigrate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	var fk, bt int
	s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode)
	s.db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	s.db.QueryRow(`PRAGMA busy_timeout`).Scan(&bt)
	if mode != "wal" || fk != 1 || bt != 5000 {
		t.Fatalf("pragmas: %s fk=%d busy=%d", mode, fk, bt)
	}
	s.Close()
	// Reopening must not re-run migrations.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows, err := s.Ranking(context.Background())
	if err != nil || len(rows) != 0 {
		t.Fatalf("%v %v", rows, err)
	}
}

func TestHash(t *testing.T) {
	// SHA-256("1" + "1700000000000") → first 7 hex.
	if h := Hash(1, 1700000000000); len(h) != 7 || h != Hash(1, 1700000000000) || h == Hash(2, 1700000000000) {
		t.Fatalf("hash %q", h)
	}
}

func TestBackup(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "live.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if err := s.CreateRun(ctx, "r1", "d", 1, 1); err != nil {
		t.Fatal(err)
	}
	bk := filepath.Join(dir, "bk.db")
	if err := s.Backup(ctx, bk); err != nil {
		t.Fatal(err)
	}
	if err := s.Backup(ctx, bk); err != nil { // overwrite works (VACUUM INTO refuses existing files)
		t.Fatal(err)
	}
	b, err := Open(bk)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if _, err := b.GetRun(ctx, "r1"); err != nil {
		t.Fatalf("backup missing data: %v", err)
	}
}

func TestPrune(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"game-20261121-120000.db", "game-20261121-120500.db", "game-20261121-121000.db", "game-latest.db"} {
		os.WriteFile(filepath.Join(dir, n), nil, 0o600)
	}
	prune(dir, 2)
	left, _ := filepath.Glob(filepath.Join(dir, "*.db"))
	if len(left) != 3 { // two newest + latest
		t.Fatalf("%v", left)
	}
	if _, err := os.Stat(filepath.Join(dir, "game-20261121-120000.db")); err == nil {
		t.Fatal("oldest not pruned")
	}
}
