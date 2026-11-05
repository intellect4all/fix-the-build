// Package api is the HTTP layer: JSON API and the embedded frontend.
package api

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"fixthebuild/internal/game"
	"fixthebuild/internal/store"
)

// PublicConfig is served at /api/config.
type PublicConfig struct {
	EventName         string `json:"event_name"`
	OrganiserName     string `json:"organiser_name"`
	OrganiserHandle   string `json:"organiser_handle"`
	OrganiserLinkedIn string `json:"organiser_linkedin"`
	OrganiserSite     string `json:"organiser_site"`
	WorkshopTitle     string `json:"workshop_title"`
	WorkshopTime      string `json:"workshop_time"`
	WorkshopRoom      string `json:"workshop_room"`
	PassThreshold     int    `json:"pass_threshold"`
	BaseURL           string `json:"base_url"`
}

type Options struct {
	Public     PublicConfig
	AdminToken string
	TrustProxy bool             // take the client IP from X-Forwarded-For (behind Caddy)
	IPLimit    int              // per-IP backstop, requests/min (default 1200)
	Static     fs.FS            // built frontend; nil = API only
	Now        func() time.Time // injectable clock for tests
}

type Server struct {
	st   *store.Store
	opt  Options
	game *game.Config
	now  func() time.Time
	mux  *http.ServeMux

	runLimit   *limiter // 1 start / 5 s / device
	mergeLimit *limiter // 5 / hour / device
	ipLimit    *counter // per-IP backstop (IP_LIMIT / min)
	loginLimit *limiter // admin login: 10 / min / IP

	cacheMu sync.Mutex
	cache   []store.Row
	cacheAt time.Time
	cacheOK bool
}

const (
	minRun = 19 * time.Second
	maxRun = 10 * time.Minute
)

func New(st *store.Store, opt Options) *Server {
	s := &Server{
		st:         st,
		opt:        opt,
		game:       &game.Default,
		now:        opt.Now,
		mux:        http.NewServeMux(),
		runLimit:   newLimiter(1, 5*time.Second),
		mergeLimit: newLimiter(5, time.Hour),
		ipLimit:    newCounter(cmp.Or(opt.IPLimit, 1200), time.Minute),
		loginLimit: newLimiter(10, time.Minute),
	}
	if s.now == nil {
		s.now = time.Now
	}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// GC trims rate-limit state; call periodically.
func (s *Server) GC() {
	now := s.now()
	s.runLimit.gc(now)
	s.mergeLimit.gc(now)
	s.ipLimit.gc(now)
	s.loginLimit.gc(now)
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := s.st.DB().PingContext(r.Context()); err != nil {
			http.Error(w, "db down", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})
	m.HandleFunc("GET /api/config", s.handleConfig)
	m.HandleFunc("GET /api/leaderboard", s.device(s.handleLeaderboard))
	m.HandleFunc("GET /api/stats", s.handleStats)

	m.HandleFunc("GET /api/me", s.backstop(s.device(s.handleMe)))
	m.HandleFunc("PATCH /api/me", s.backstop(s.device(s.handlePatchMe)))
	m.HandleFunc("DELETE /api/me", s.backstop(s.device(s.handleDeleteMe)))
	m.HandleFunc("POST /api/runs", s.backstop(s.device(s.handleStartRun)))
	m.HandleFunc("POST /api/runs/{id}/finish", s.backstop(s.device(s.handleFinish)))
	m.HandleFunc("POST /api/merge", s.backstop(s.device(s.handleMerge)))
	s.adminRoutes()
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "No such endpoint.")
	})

	if s.opt.Static != nil {
		m.Handle("/", s.static())
	}
}

// ------------------------------------------------------------------ helpers

type ctxKey struct{}

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func deviceOf(r *http.Request) string { d, _ := r.Context().Value(ctxKey{}).(string); return d }

// device requires a UUID-shaped device token (header, falling back to cookie).
func (s *Server) device(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Device-Token")))
		if t == "" {
			if c, err := r.Cookie("ftb_device"); err == nil {
				t = strings.ToLower(c.Value)
			}
		}
		if !uuidRE.MatchString(t) {
			writeErr(w, http.StatusBadRequest, "no_device", "Missing or invalid device token.")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, t)))
	}
}

// backstop is the generous per-IP limit for write-ish endpoints. Polling
// endpoints are exempt: a whole venue shares one NAT address.
func (s *Server) backstop(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.ipLimit.allow(s.clientIP(r), s.now()) {
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many requests from this network. Give it a minute.")
			return
		}
		h(w, r)
	}
}

func (s *Server) clientIP(r *http.Request) string {
	if s.opt.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1]) // the hop Caddy saw
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, map[string]any{"error": map[string]string{"code": errCode, "message": msg}})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", "Request body isn't valid JSON.")
		return false
	}
	return true
}

func (s *Server) internal(w http.ResponseWriter, err error) {
	log.Printf("error: %v", err)
	writeErr(w, http.StatusInternalServerError, "internal", "Something broke on our side. Try again?")
}

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func randomSeed() uint32 {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return binary.LittleEndian.Uint32(b[:])
}

func ms(t time.Time) int64 { return t.UnixMilli() }

// cleanText trims, drops control characters, and collapses whitespace runs.
func cleanText(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

func handleLabel(typ, h string) string {
	if typ == "linkedin" {
		return "in/" + h
	}
	return "@" + h
}

// ------------------------------------------------------------------ leaderboard cache (2 s)

func (s *Server) ranking(ctx context.Context) ([]store.Row, error) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if s.cacheOK && s.now().Sub(s.cacheAt) < 2*time.Second {
		return s.cache, nil
	}
	rows, err := s.st.Ranking(ctx)
	if err != nil {
		return nil, err
	}
	s.cache, s.cacheAt, s.cacheOK = rows, s.now(), true
	return rows, nil
}

func (s *Server) invalidate() {
	s.cacheMu.Lock()
	s.cacheOK = false
	s.cacheMu.Unlock()
}

func rankOf(rows []store.Row, playerID int64) int {
	for _, r := range rows {
		if r.PlayerID == playerID {
			return r.Rank
		}
	}
	return 0
}

// ------------------------------------------------------------------ handlers

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.opt.Public)
}

type meResp struct {
	Merged        bool   `json:"merged"`
	Name          string `json:"name,omitempty"`
	HandleType    string `json:"handle_type,omitempty"`
	Handle        string `json:"handle,omitempty"`
	CommitMessage string `json:"commit_message,omitempty"`
	Hash          string `json:"hash,omitempty"`
	Best          *int   `json:"best"`
	Pushes        int    `json:"pushes"`
	Rank          *int   `json:"rank,omitempty"`
}

func (s *Server) me(ctx context.Context, device string) (meResp, error) {
	p, err := s.st.PlayerByDevice(ctx, device)
	if errors.Is(err, store.ErrNotFound) {
		best, pushes, err := s.st.DeviceStats(ctx, device)
		if err != nil {
			return meResp{}, err
		}
		m := meResp{Pushes: pushes}
		if best >= 0 {
			m.Best = &best
		}
		return m, nil
	}
	if err != nil {
		return meResp{}, err
	}
	best, pushes, err := s.st.PlayerStats(ctx, p.ID)
	if err != nil {
		return meResp{}, err
	}
	best = max(best, 0)
	rows, err := s.ranking(ctx)
	if err != nil {
		return meResp{}, err
	}
	rank := rankOf(rows, p.ID)
	return meResp{
		Merged: true, Name: p.Name, HandleType: p.HandleType, Handle: p.Handle, CommitMessage: p.CommitMessage,
		Hash: store.Hash(p.ID, p.CreatedAt), Best: &best, Pushes: pushes, Rank: &rank,
	}, nil
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	m, err := s.me(r.Context(), deviceOf(r))
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) handleStartRun(w http.ResponseWriter, r *http.Request) {
	dev := deviceOf(r)
	now := s.now()
	if !s.runLimit.allow(dev, now) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Easy! One push every 5 seconds.")
		return
	}
	id, seed := randomID(), randomSeed()
	if err := s.st.CreateRun(r.Context(), id, dev, seed, ms(now)); err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"run_id": id, "seed": seed, "started_at": ms(now)})
}

type finishResp struct {
	Score        int     `json:"score"`
	Best         int     `json:"best"`
	IsNewBest    bool    `json:"is_new_best"`
	Rank         *int    `json:"rank"`
	PassedPlayer *string `json:"passed_player,omitempty"`
}

func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dev := deviceOf(r)
	var res game.Result
	if !readJSON(w, r, &res) {
		return
	}
	run, err := s.st.GetRun(ctx, r.PathValue("id"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && run.DeviceToken != dev) {
		writeErr(w, http.StatusNotFound, "bad_run", "Unknown run.")
		return
	}
	if err != nil {
		s.internal(w, err)
		return
	}

	p, perr := s.st.PlayerByDevice(ctx, dev)
	merged := perr == nil
	if perr != nil && !errors.Is(perr, store.ErrNotFound) {
		s.internal(w, perr)
		return
	}
	stats := func() (int, error) {
		if merged {
			b, _, err := s.st.PlayerStats(ctx, p.ID)
			return b, err
		}
		b, _, err := s.st.DeviceStats(ctx, dev)
		return b, err
	}

	// A retried finish (response lost on bad mobile data) just gets the current state.
	if run.FinishedAt.Valid {
		best, err := stats()
		if err != nil {
			s.internal(w, err)
			return
		}
		out := finishResp{Score: int(run.Score.Int64), Best: max(best, 0)}
		if merged {
			rows, _ := s.ranking(ctx)
			k := rankOf(rows, p.ID)
			out.Rank = &k
		}
		writeJSON(w, http.StatusOK, out)
		return
	}

	prevBest, err := stats()
	if err != nil {
		s.internal(w, err)
		return
	}
	var before []store.Row
	if merged {
		if before, err = s.ranking(ctx); err != nil {
			s.internal(w, err)
			return
		}
	}

	now := s.now()
	reason := ""
	if el := now.Sub(time.UnixMilli(run.StartedAt)); el < minRun {
		reason = "too fast: " + el.Round(time.Millisecond).String()
	} else if el > maxRun {
		reason = "too slow: " + el.Round(time.Second).String()
	} else {
		reason = game.Check(run.Seed, res, s.game)
	}
	if res.Negative() {
		res = game.Result{} // don't store garbage
	}
	ok, err := s.st.FinishRun(ctx, run.ID, res, ms(now), reason)
	if err != nil {
		s.internal(w, err)
		return
	}
	if !ok { // lost a race with a concurrent finish
		writeJSON(w, http.StatusOK, finishResp{Score: res.Score, Best: max(prevBest, 0)})
		return
	}
	if reason != "" {
		log.Printf("flagged run %s: %s", run.ID[:8], reason)
	} else {
		s.invalidate()
	}

	// Flagged runs get a normal-looking answer.
	out := finishResp{Score: res.Score, Best: max(prevBest, res.Score, 0), IsNewBest: res.Score > prevBest}
	if merged {
		after, err := s.ranking(ctx)
		if err != nil {
			s.internal(w, err)
			return
		}
		was, cur := rankOf(before, p.ID), rankOf(after, p.ID)
		out.Rank = &cur
		if reason == "" && cur > 0 && was > cur && cur < len(after) {
			lbl := handleLabel(after[cur].HandleType, after[cur].Handle) // the row just below me
			out.PassedPlayer = &lbl
		}
	}
	writeJSON(w, http.StatusOK, out)
}

type mergeReq struct {
	Name          string `json:"name"`
	Handle        string `json:"handle"`
	HandleType    string `json:"handle_type"`
	CommitMessage string `json:"commit_message"`
	Consent       bool   `json:"consent"`
	RunID         string `json:"run_id"`
}

func validMessage(msg string) (string, bool) {
	msg = cleanText(msg)
	n := utf8.RuneCountInString(msg)
	return msg, n >= 1 && n <= 72
}

func (s *Server) handleMerge(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dev := deviceOf(r)
	var b mergeReq
	if !readJSON(w, r, &b) {
		return
	}
	name := cleanText(b.Name)
	if n := utf8.RuneCountInString(name); n < 2 || n > 40 {
		writeErr(w, http.StatusBadRequest, "bad_name", "Name must be 2–40 characters.")
		return
	}
	fb := "x"
	if b.HandleType == "linkedin" {
		fb = "linkedin"
	}
	typ, handle, ok := NormalizeHandle(b.Handle, fb)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_handle", "That doesn’t look like an X handle or LinkedIn URL.")
		return
	}
	msg, ok := validMessage(b.CommitMessage)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_message", "Commit message must be 1–72 characters.")
		return
	}
	if !b.Consent {
		writeErr(w, http.StatusBadRequest, "no_consent", "Please tick the consent box.")
		return
	}
	// Counted only once the form is valid: typos don't burn attempts; probing handles does.
	if !s.mergeLimit.allow(dev, s.now()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many merge attempts. Try again later.")
		return
	}
	_, err := s.st.Merge(ctx, store.Player{
		DeviceToken: dev, Name: name, HandleType: typ, Handle: handle, CommitMessage: msg, CreatedAt: ms(s.now()),
	}, b.RunID)
	switch {
	case errors.Is(err, store.ErrAlreadyMerged):
		writeErr(w, http.StatusConflict, "already_merged", "This device already merged.")
		return
	case errors.Is(err, store.ErrHandleTaken):
		writeErr(w, http.StatusConflict, "handle_taken",
			"That handle already merged. If it’s you on a new phone, ask "+s.opt.Public.OrganiserName+" to link it.")
		return
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusBadRequest, "bad_run", "Play a round first.")
		return
	case err != nil:
		s.internal(w, err)
		return
	}
	s.invalidate()
	m, err := s.me(ctx, dev)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, m)
}

func (s *Server) handlePatchMe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	dev := deviceOf(r)
	var b struct {
		CommitMessage string `json:"commit_message"`
	}
	if !readJSON(w, r, &b) {
		return
	}
	p, err := s.st.PlayerByDevice(ctx, dev)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not_merged", "Merge first.")
		return
	} else if err != nil {
		s.internal(w, err)
		return
	}
	msg, ok := validMessage(b.CommitMessage)
	if !ok {
		writeErr(w, http.StatusBadRequest, "bad_message", "Commit message must be 1–72 characters.")
		return
	}
	if err := s.st.SetCommitMessage(ctx, p.ID, msg); err != nil {
		s.internal(w, err)
		return
	}
	s.invalidate()
	m, err := s.me(ctx, dev)
	if err != nil {
		s.internal(w, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (s *Server) handleDeleteMe(w http.ResponseWriter, r *http.Request) {
	if err := s.st.DeleteDevice(r.Context(), deviceOf(r)); err != nil {
		s.internal(w, err)
		return
	}
	s.invalidate()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit := 50
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v >= 1 && v <= 100 {
		limit = v
	}
	all, err := s.ranking(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	var myID int64 = -1
	if p, err := s.st.PlayerByDevice(ctx, deviceOf(r)); err == nil {
		myID = p.ID
	}
	n := min(limit, len(all))
	rows := make([]store.Row, n)
	copy(rows, all[:n]) // copy: never mutate the shared cache
	var me *store.Row
	for i := range rows {
		rows[i].Me = rows[i].PlayerID == myID
	}
	if k := rankOf(all, myID); k > n {
		row := all[k-1]
		row.Me = true
		me = &row
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows, "me": me, "total_players": len(all)})
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	all, err := s.ranking(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	pushes, err := s.st.TotalPushes(ctx)
	if err != nil {
		s.internal(w, err)
		return
	}
	var top, most, latest *store.Row
	for i := range all {
		r := &all[i]
		if r.Pushes == 0 {
			continue
		}
		if top == nil {
			top = r
		}
		if most == nil || r.Pushes > most.Pushes {
			most = r
		}
		if latest == nil || r.MergedAt > latest.MergedAt {
			latest = r
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_players": len(all), "total_pushes": pushes,
		"top": all[:min(10, len(all))], "top_contributor": top, "most_pushes": most, "latest_merge": latest,
	})
}

// ------------------------------------------------------------------ static frontend

func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.opt.Static)
	pages := map[string]string{
		"/": "index.html", "/play-test": "play-test/index.html", "/play-test/": "play-test/index.html",
		"/board": "board.html", "/admin": "admin.html", "/privacy": "privacy.html",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if page, ok := pages[r.URL.Path]; ok {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, s.opt.Static, page)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
