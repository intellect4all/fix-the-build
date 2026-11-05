package api

import (
	"log"
	"net/http"
	"strings"
	"time"
)

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) { w.code = c; w.ResponseWriter.WriteHeader(c) }

// Middleware adds security headers, panic recovery, and a request log for the
// API. It never logs IP addresses.
func Middleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Content-Security-Policy",
			"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		sw := &statusWriter{ResponseWriter: w, code: 200}
		start := time.Now()
		defer func() {
			if p := recover(); p != nil {
				log.Printf("panic %s %s: %v", r.Method, r.URL.Path, p)
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/") && (r.Method != http.MethodGet || sw.code >= 400) {
				log.Printf("%s %s %d %s", r.Method, r.URL.Path, sw.code, time.Since(start).Round(time.Microsecond))
			}
		}()
		h.ServeHTTP(sw, r)
	})
}
