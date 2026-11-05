package api

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func (e *env) adminDo(token, method, path string, body any) (int, string) {
	e.t.Helper()
	var buf bytes.Buffer
	if body != nil {
		json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Admin-Token", token)
	}
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestAdmin(t *testing.T) {
	e := newEnv(t)
	e.srv.opt.AdminToken = "s3cret"
	a := dev(1)
	r := e.play(a, 20)
	e.merge(a, "Tunde", "tunde", r["run_id"].(string))

	if code, _ := e.adminDo("", "GET", "/api/admin/players", nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := e.adminDo("wrong", "GET", "/api/admin/players", nil); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	code, body := e.adminDo("s3cret", "GET", "/api/admin/players", nil)
	var list struct {
		Players []adminPlayer `json:"players"`
	}
	json.Unmarshal([]byte(body), &list)
	if code != 200 || len(list.Players) != 1 || list.Players[0].Device != a[:8] {
		t.Fatalf("list: %d %s", code, body)
	}
	id := "/api/admin/players/" + itoa(list.Players[0].ID)

	// Hide → off the board; unhide → back.
	e.adminDo("s3cret", "PATCH", id, map[string]any{"hidden": true})
	if rows := e.board(a); len(rows) != 0 {
		t.Fatalf("hidden still listed: %v", rows)
	}
	e.adminDo("s3cret", "PATCH", id, map[string]any{"hidden": false, "commit_message": "=HYPERLINK(\"x\")"})
	rows := e.board(a)
	if len(rows) != 1 || rows[0]["commit_message"] != `=HYPERLINK("x")` {
		t.Fatalf("unhide/edit: %v", rows)
	}

	// New phone: plays once, can't merge (handle taken), admin links it by short code.
	phone := "abcdef12-0000-4000-8000-000000000001"
	e.clk.add(time.Minute)
	rp := e.play(phone, 25)
	if code, _ := e.merge(phone, "Tunde", "tunde", rp["run_id"].(string)); code != 409 {
		t.Fatalf("expected handle_taken, got %d", code)
	}
	if code, body := e.adminDo("s3cret", "PATCH", id, map[string]any{"device": "abcdef12"}); code != 204 {
		t.Fatalf("reassign: %d %s", code, body)
	}
	_, me := e.do(phone, "GET", "/api/me", nil)
	if me["merged"] != true || me["best"].(float64) != 25 || me["pushes"].(float64) != 2 {
		t.Fatalf("new phone me: %v", me)
	}
	if code, _ := e.adminDo("s3cret", "PATCH", id, map[string]any{"device": "ffffffff"}); code != 400 {
		t.Fatalf("unknown code: %d", code)
	}

	code, csv := e.adminDo("s3cret", "GET", "/api/admin/export.csv", nil)
	if code != 200 || !strings.Contains(csv, "Tunde,x,tunde,https://x.com/tunde,25,2,") || !strings.Contains(csv, `'=HYPERLINK`) {
		t.Fatalf("csv: %d\n%s", code, csv)
	}

	// Writes need JSON (CSRF guard for cookie auth).
	req := httptest.NewRequest("PATCH", id, strings.NewReader(`{"hidden":true}`))
	req.Header.Set("X-Admin-Token", "s3cret")
	req.Header.Set("Content-Type", "text/plain")
	rec := httptest.NewRecorder()
	e.srv.ServeHTTP(rec, req)
	if rec.Code != 415 {
		t.Fatalf("non-JSON write: %d", rec.Code)
	}

	// Login sets an HttpOnly cookie that works on its own.
	code, _ = e.adminDo("", "POST", "/api/admin/login", map[string]any{"token": "s3cret"})
	if code != 204 {
		t.Fatalf("login: %d", code)
	}
}

func TestAdminDisabledWithoutToken(t *testing.T) {
	e := newEnv(t)
	if code, _ := e.adminDo("", "GET", "/api/admin/players", nil); code != 404 {
		t.Fatalf("%d", code)
	}
	if code, _ := e.adminDo("", "POST", "/api/admin/login", map[string]any{"token": ""}); code != 404 {
		t.Fatalf("%d", code)
	}
}

func TestStatsEmpty(t *testing.T) {
	e := newEnv(t)
	_, st := e.do("", "GET", "/api/stats", nil)
	if top, ok := st["top"].([]any); !ok || len(top) != 0 {
		t.Fatalf("top should be []: %v", st)
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }
