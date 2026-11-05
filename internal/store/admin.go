package store

import (
	"context"
	"strings"
)

type AdminPlayer struct {
	Player
	Best    int // -1 when no valid run
	Pushes  int
	Flagged int
}

// AdminPlayers lists every player, hidden or not, newest first.
func (s *Store) AdminPlayers(ctx context.Context) ([]AdminPlayer, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT p.id, p.device_token, p.name, p.handle_type, p.handle, p.commit_message, p.hidden, p.created_at,
		  COALESCE(MAX(CASE WHEN r.flagged = 0 AND r.finished_at IS NOT NULL THEN r.score END), -1),
		  COUNT(CASE WHEN r.flagged = 0 AND r.finished_at IS NOT NULL THEN 1 END),
		  COUNT(CASE WHEN r.flagged = 1 THEN 1 END)
		FROM players p LEFT JOIN runs r ON r.player_id = p.id
		GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminPlayer{}
	for rows.Next() {
		var a AdminPlayer
		if err := rows.Scan(&a.ID, &a.DeviceToken, &a.Name, &a.HandleType, &a.Handle, &a.CommitMessage, &a.Hidden, &a.CreatedAt,
			&a.Best, &a.Pushes, &a.Flagged); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

type FlaggedRun struct {
	ID         string `json:"id"`
	Device     string `json:"device"` // 8-char prefix
	PlayerName string `json:"player_name,omitempty"`
	Handle     string `json:"handle,omitempty"`
	Score      int    `json:"score"`
	Taps       int    `json:"taps"`
	Reason     string `json:"reason"`
	FinishedAt int64  `json:"finished_at"`
}

func (s *Store) FlaggedRuns(ctx context.Context, limit int) ([]FlaggedRun, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT r.id, substr(r.device_token, 1, 8), COALESCE(p.name, ''), COALESCE(p.handle, ''),
		       COALESCE(r.score, 0), COALESCE(r.taps, 0), COALESCE(r.flag_reason, ''), COALESCE(r.finished_at, 0)
		FROM runs r LEFT JOIN players p ON p.id = r.player_id
		WHERE r.flagged = 1 ORDER BY r.finished_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FlaggedRun{}
	for rows.Next() {
		var f FlaggedRun
		if err := rows.Scan(&f.ID, &f.Device, &f.PlayerName, &f.Handle, &f.Score, &f.Taps, &f.Reason, &f.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

type Totals struct {
	Players int `json:"players"`
	Runs    int `json:"runs"`
	Flagged int `json:"flagged"`
	Devices int `json:"devices"`
}

func (s *Store) Totals(ctx context.Context) (Totals, error) {
	var t Totals
	err := s.db.QueryRowContext(ctx, `
		SELECT (SELECT COUNT(*) FROM players),
		       (SELECT COUNT(*) FROM runs WHERE finished_at IS NOT NULL),
		       (SELECT COUNT(*) FROM runs WHERE flagged = 1),
		       (SELECT COUNT(DISTINCT device_token) FROM runs)`).Scan(&t.Players, &t.Runs, &t.Flagged, &t.Devices)
	return t, err
}

// ResolveDevice expands the short device code a player reads out (first 8
// hex chars) to the full token. The device must have played at least once.
func (s *Store) ResolveDevice(ctx context.Context, code string) (string, error) {
	code = strings.ToLower(strings.TrimSpace(code))
	if len(code) < 8 || strings.ContainsAny(code, "%_") {
		return "", ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT device_token FROM runs WHERE device_token LIKE ? || '%' LIMIT 2`, code)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return "", err
		}
		found = append(found, d)
	}
	if len(found) != 1 {
		return "", ErrNotFound
	}
	return found[0], rows.Err()
}
