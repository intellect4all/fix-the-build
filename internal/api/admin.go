package api

import (
	"crypto/subtle"
	"encoding/csv"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fixthebuild/internal/store"
)

// Admin: ADMIN_TOKEN via X-Admin-Token header or the admin_token
// cookie set by /api/admin/login. Disabled entirely when no token is configured.

func (s *Server) adminRoutes() {
	m := s.mux
	m.HandleFunc("POST /api/admin/login", s.handleAdminLogin)
	m.HandleFunc("POST /api/admin/logout", s.handleAdminLogout)
	m.HandleFunc("GET /api/admin/players", s.admin(s.handleAdminPlayers))
	m.HandleFunc("PATCH /api/admin/players/{id}", s.admin(s.handleAdminPatch))
	m.HandleFunc("GET /api/admin/export.csv", s.admin(s.handleAdminCSV))
}

func (s *Server) tokenOK(t string) bool {
	return s.opt.AdminToken != "" && subtle.ConstantTimeCompare([]byte(t), []byte(s.opt.AdminToken)) == 1
}

func (s *Server) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.opt.AdminToken == "" {
			writeErr(w, http.StatusNotFound, "not_found", "Admin is disabled (set ADMIN_TOKEN).")
			return
		}
		t := r.Header.Get("X-Admin-Token")
		if t == "" {
			if c, err := r.Cookie("admin_token"); err == nil {
				t = c.Value
			}
		}
		if !s.tokenOK(t) {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "Wrong or missing admin token.")
			return
		}
		// Cookie auth + JSON-only writes: a cross-site form can't send this content type.
		if r.Method != http.MethodGet && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			writeErr(w, http.StatusUnsupportedMediaType, "json_only", "Send JSON.")
			return
		}
		h(w, r)
	}
}

func (s *Server) secureCookie(r *http.Request) bool {
	return r.TLS != nil || (s.opt.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https")
}

func (s *Server) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	if s.opt.AdminToken == "" {
		writeErr(w, http.StatusNotFound, "not_found", "Admin is disabled (set ADMIN_TOKEN).")
		return
	}
	if !s.loginLimit.allow(s.clientIP(r), s.now()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Wait a minute.")
		return
	}
	var b struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &b) {
		return
	}
	if !s.tokenOK(b.Token) {
		writeErr(w, http.StatusUnauthorized, "unauthorized", "Wrong admin token.")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: "admin_token", Value: b.Token, Path: "/", MaxAge: int((12 * time.Hour).Seconds()),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.secureCookie(r),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "admin_token", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(http.StatusNoContent)
}

type adminPlayer struct {
	ID            int64  `json:"id"`
	Device        string `json:"device"` // short code
	Name          string `json:"name"`
	HandleType    string `json:"handle_type"`
	Handle        string `json:"handle"`
	CommitMessage string `json:"commit_message"`
	Hidden        bool   `json:"hidden"`
	CreatedAt     int64  `json:"created_at"`
	Best          *int   `json:"best"`
	Pushes        int    `json:"pushes"`
	Flagged       int    `json:"flagged"`
	Rank          int    `json:"rank"`
}

func (s *Server) handleAdminPlayers(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ps, err := s.st.AdminPlayers(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	rows, err := s.ranking(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	tot, err := s.st.Totals(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	flagged, err := s.st.FlaggedRuns(ctx, 100)
	if err != nil {
		s.internal(w, err)
		return
	}
	out := make([]adminPlayer, len(ps))
	for i, p := range ps {
		a := adminPlayer{
			ID: p.ID, Device: p.DeviceToken[:8], Name: p.Name, HandleType: p.HandleType, Handle: p.Handle,
			CommitMessage: p.CommitMessage, Hidden: p.Hidden, CreatedAt: p.CreatedAt, Pushes: p.Pushes,
			Flagged: p.Flagged, Rank: rankOf(rows, p.ID),
		}
		if p.Best >= 0 {
			b := p.Best
			a.Best = &b
		}
		out[i] = a
	}
	writeJSON(w, http.StatusOK, map[string]any{"totals": tot, "players": out, "flagged": flagged})
}

func (s *Server) handleAdminPatch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_id", "Bad player id.")
		return
	}
	var b struct {
		Hidden        *bool   `json:"hidden"`
		CommitMessage *string `json:"commit_message"`
		Device        *string `json:"device"` // short code or full token of the new phone
	}
	if !readJSON(w, r, &b) {
		return
	}
	if _, err := s.st.PlayerByID(ctx, id); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not_found", "No such player.")
		return
	} else if err != nil {
		s.internal(w, err)
		return
	}
	if b.CommitMessage != nil {
		msg, ok := validMessage(*b.CommitMessage)
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_message", "Commit message must be 1–72 characters.")
			return
		}
		if err := s.st.SetCommitMessage(ctx, id, msg); err != nil {
			s.internal(w, err)
			return
		}
	}
	if b.Hidden != nil {
		if err := s.st.SetHidden(ctx, id, *b.Hidden); err != nil {
			s.internal(w, err)
			return
		}
	}
	if b.Device != nil {
		code := strings.ToLower(strings.TrimSpace(*b.Device))
		full := code
		if !uuidRE.MatchString(code) {
			if full, err = s.st.ResolveDevice(ctx, code); err != nil {
				writeErr(w, http.StatusBadRequest, "bad_device", "No single device matches that code. The new phone must play one round first.")
				return
			}
		}
		switch err := s.st.Reassign(ctx, id, full); {
		case errors.Is(err, store.ErrAlreadyMerged):
			writeErr(w, http.StatusConflict, "device_taken", "That phone already belongs to another player.")
			return
		case err != nil:
			s.internal(w, err)
			return
		}
	}
	s.invalidate()
	w.WriteHeader(http.StatusNoContent)
}

// csvSafe stops spreadsheet formula injection (a commit message of "=HYPERLINK(...)").
func csvSafe(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		return "'" + v
	}
	return v
}

func (s *Server) handleAdminCSV(w http.ResponseWriter, r *http.Request) {
	ps, err := s.st.AdminPlayers(r.Context())
	if err != nil {
		s.internal(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="fix-the-build-players.csv"`)
	w.Header().Set("Cache-Control", "no-store")
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"name", "handle_type", "handle", "profile_url", "best", "pushes", "commit_message", "joined_at", "hidden", "flagged_runs"})
	for _, p := range ps {
		url := "https://x.com/" + p.Handle
		if p.HandleType == "linkedin" {
			url = "https://www.linkedin.com/in/" + p.Handle
		}
		best := ""
		if p.Best >= 0 {
			best = strconv.Itoa(p.Best)
		}
		_ = cw.Write([]string{
			csvSafe(p.Name), p.HandleType, p.Handle, url, best, strconv.Itoa(p.Pushes), csvSafe(p.CommitMessage),
			time.UnixMilli(p.CreatedAt).UTC().Format(time.RFC3339), strconv.FormatBool(p.Hidden), strconv.Itoa(p.Flagged),
		})
	}
	cw.Flush()
}
