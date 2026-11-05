// Package store is the SQLite layer. One connection (SQLite serialises writes
// anyway; at ~500 players every query is sub-millisecond), WAL so the backup
// can read while we write.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"sort"
	"strings"

	"fixthebuild/internal/game"
	"fixthebuild/migrations"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrHandleTaken   = errors.New("handle taken")
	ErrAlreadyMerged = errors.New("already merged")
)

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	// Pragmas in the DSN apply to every connection the pool opens.
	dsn := "file:" + url.PathEscape(path) +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }
func (s *Store) DB() *sql.DB  { return s.db }

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	names, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for i, n := range names {
		if i < v {
			continue
		}
		b, err := migrations.FS.ReadFile(n)
		if err != nil {
			return err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(b)); err != nil {
			tx.Rollback()
			return fmt.Errorf("%s: %w", n, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// ------------------------------------------------------------------ types

type Player struct {
	ID            int64
	DeviceToken   string
	Name          string
	HandleType    string
	Handle        string
	CommitMessage string
	Hidden        bool
	CreatedAt     int64
}

// Hash is the first 7 hex chars of SHA-256(player_id + created_at), as decimal strings.
func Hash(id, createdAt int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d%d", id, createdAt)))
	return hex.EncodeToString(sum[:])[:7]
}

type Run struct {
	ID          string
	DeviceToken string
	PlayerID    sql.NullInt64
	Seed        uint32
	StartedAt   int64
	FinishedAt  sql.NullInt64
	Score       sql.NullInt64
	Flagged     bool
}

type Row struct {
	Rank          int    `json:"rank"`
	PlayerID      int64  `json:"-"`
	Hash          string `json:"hash"`
	Name          string `json:"name"`
	HandleType    string `json:"handle_type"`
	Handle        string `json:"handle"`
	CommitMessage string `json:"commit_message"`
	Best          int    `json:"best"`
	Pushes        int    `json:"pushes"`
	MergedAt      int64  `json:"merged_at"`
	Me            bool   `json:"me,omitempty"`
}

// ------------------------------------------------------------------ runs

func (s *Store) CreateRun(ctx context.Context, id, device string, seed uint32, startedAt int64) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO runs (id, device_token, player_id, seed, started_at)
		VALUES (?, ?, (SELECT id FROM players WHERE device_token = ?), ?, ?)`,
		id, device, device, int64(seed), startedAt)
	return err
}

func (s *Store) GetRun(ctx context.Context, id string) (Run, error) {
	var r Run
	var seed int64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, device_token, player_id, seed, started_at, finished_at, score, flagged
		FROM runs WHERE id = ?`, id).
		Scan(&r.ID, &r.DeviceToken, &r.PlayerID, &seed, &r.StartedAt, &r.FinishedAt, &r.Score, &r.Flagged)
	if errors.Is(err, sql.ErrNoRows) {
		return r, ErrNotFound
	}
	r.Seed = uint32(seed)
	return r, err
}

// FinishRun records the result once. It returns false if the run was already finished.
func (s *Store) FinishRun(ctx context.Context, id string, g game.Result, finishedAt int64, flagReason string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE runs SET finished_at = ?, bugs = ?, bugs_x1 = ?, bugs_x2 = ?, bugs_x3 = ?, golden = ?,
		  features_hit = ?, max_combo = ?, taps = ?, score = ?, flagged = ?, flag_reason = NULLIF(?, '')
		WHERE id = ? AND finished_at IS NULL`,
		finishedAt, g.Bugs, g.BugsX1, g.BugsX2, g.BugsX3, g.Golden, g.FeaturesHit, g.MaxCombo, g.Taps, g.Score,
		flagReason != "", flagReason, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// MarkFlagged flags a run without touching its recorded result (e.g. a second finish).
func (s *Store) MarkFlagged(ctx context.Context, id, reason string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE runs SET flag_reason = COALESCE(flag_reason || '; ', '') || ? WHERE id = ?`, reason, id)
	return err
}

// Best and pushes for a device's unattached runs, or a player's runs. Only
// finished, unflagged runs count. best is -1 when there are none.
func (s *Store) DeviceStats(ctx context.Context, device string) (best, pushes int, err error) {
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(score), -1), COUNT(*) FROM runs
		WHERE device_token = ? AND player_id IS NULL AND finished_at IS NOT NULL AND flagged = 0`, device).
		Scan(&best, &pushes)
	return
}

func (s *Store) PlayerStats(ctx context.Context, playerID int64) (best, pushes int, err error) {
	err = s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(score), -1), COUNT(*) FROM runs
		WHERE player_id = ? AND finished_at IS NOT NULL AND flagged = 0`, playerID).
		Scan(&best, &pushes)
	return
}

// ------------------------------------------------------------------ players

const playerCols = `id, device_token, name, handle_type, handle, commit_message, hidden, created_at`

func scanPlayer(row interface{ Scan(...any) error }) (Player, error) {
	var p Player
	err := row.Scan(&p.ID, &p.DeviceToken, &p.Name, &p.HandleType, &p.Handle, &p.CommitMessage, &p.Hidden, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) PlayerByDevice(ctx context.Context, device string) (Player, error) {
	return scanPlayer(s.db.QueryRowContext(ctx, `SELECT `+playerCols+` FROM players WHERE device_token = ?`, device))
}

func (s *Store) PlayerByID(ctx context.Context, id int64) (Player, error) {
	return scanPlayer(s.db.QueryRowContext(ctx, `SELECT `+playerCols+` FROM players WHERE id = ?`, id))
}

// Merge creates the player for this device and attaches every run the device
// played before merging. runID must be one of this device's runs.
func (s *Store) Merge(ctx context.Context, p Player, runID string) (Player, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return p, err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM players WHERE device_token = ?`, p.DeviceToken).Scan(&n); err != nil {
		return p, err
	}
	if n > 0 {
		return p, ErrAlreadyMerged
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE id = ? AND device_token = ?`, runID, p.DeviceToken).Scan(&n); err != nil {
		return p, err
	}
	if n == 0 {
		return p, ErrNotFound
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM players WHERE handle_type = ? AND handle = ?`, p.HandleType, p.Handle).Scan(&n); err != nil {
		return p, err
	}
	if n > 0 {
		return p, ErrHandleTaken
	}
	res, err := tx.ExecContext(ctx, `
		INSERT INTO players (device_token, name, handle_type, handle, commit_message, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, p.DeviceToken, p.Name, p.HandleType, p.Handle, p.CommitMessage, p.CreatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return p, ErrHandleTaken
		}
		return p, err
	}
	p.ID, _ = res.LastInsertId()
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET player_id = ? WHERE device_token = ? AND player_id IS NULL`, p.ID, p.DeviceToken); err != nil {
		return p, err
	}
	return p, tx.Commit()
}

func (s *Store) SetCommitMessage(ctx context.Context, playerID int64, msg string) error {
	return s.exec1(ctx, `UPDATE players SET commit_message = ? WHERE id = ?`, msg, playerID)
}

func (s *Store) SetHidden(ctx context.Context, playerID int64, hidden bool) error {
	return s.exec1(ctx, `UPDATE players SET hidden = ? WHERE id = ?`, hidden, playerID)
}

// Reassign links a player to a new device (new phone) and pulls in any runs
// that device played before.
func (s *Store) Reassign(ctx context.Context, playerID int64, device string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM players WHERE device_token = ? AND id <> ?`, device, playerID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrAlreadyMerged
	}
	res, err := tx.ExecContext(ctx, `UPDATE players SET device_token = ? WHERE id = ?`, device, playerID)
	if err != nil {
		return err
	}
	if k, _ := res.RowsAffected(); k == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET player_id = ? WHERE device_token = ? AND player_id IS NULL`, playerID, device); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteDevice removes the device's player (if any) and every run it touched.
func (s *Store) DeleteDevice(ctx context.Context, device string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM runs WHERE device_token = ?
		   OR player_id IN (SELECT id FROM players WHERE device_token = ?)`, device, device); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM players WHERE device_token = ?`, device); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) exec1(ctx context.Context, q string, args ...any) error {
	res, err := s.db.ExecContext(ctx, q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ------------------------------------------------------------------ leaderboard

// Ranking returns every visible player, ranked by best unflagged score; ties
// go to whoever reached that score first. Players with no valid run yet sit
// at the bottom with best 0.
func (s *Store) Ranking(ctx context.Context) ([]Row, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH valid AS (
		  SELECT player_id, score, finished_at FROM runs
		  WHERE player_id IS NOT NULL AND finished_at IS NOT NULL AND flagged = 0
		), best AS (
		  SELECT player_id, MAX(score) AS best, COUNT(*) AS pushes FROM valid GROUP BY player_id
		), reached AS (
		  SELECT v.player_id, MIN(v.finished_at) AS at
		  FROM valid v JOIN best b ON b.player_id = v.player_id AND v.score = b.best
		  GROUP BY v.player_id
		)
		SELECT p.id, p.name, p.handle_type, p.handle, p.commit_message, p.created_at,
		       COALESCE(b.best, 0), COALESCE(b.pushes, 0), b.best IS NULL, COALESCE(r.at, p.created_at)
		FROM players p
		LEFT JOIN best b ON b.player_id = p.id
		LEFT JOIN reached r ON r.player_id = p.id
		WHERE p.hidden = 0
		ORDER BY (b.best IS NULL), COALESCE(b.best, 0) DESC, COALESCE(r.at, p.created_at), p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var r Row
		var none bool
		var at int64
		if err := rows.Scan(&r.PlayerID, &r.Name, &r.HandleType, &r.Handle, &r.CommitMessage, &r.MergedAt, &r.Best, &r.Pushes, &none, &at); err != nil {
			return nil, err
		}
		r.Hash = Hash(r.PlayerID, r.MergedAt)
		r.Rank = len(out) + 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// TotalPushes counts every valid finished run, merged or not.
func (s *Store) TotalPushes(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE finished_at IS NOT NULL AND flagged = 0`).Scan(&n)
	return n, err
}
