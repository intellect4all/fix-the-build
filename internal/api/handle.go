package api

import (
	"net/url"
	"regexp"
	"strings"
)

// Mirrors web/src/handle.ts; the table test covers the same cases.
var (
	xRE      = regexp.MustCompile(`^[a-z0-9_]{1,15}$`)
	liRE     = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{1,99}$`)
	urlRE    = regexp.MustCompile(`(?i)^(?:https?://)?(?:[a-z]{2,3}\.|mobile\.)?(x\.com|twitter\.com|linkedin\.com)/(.*)$`)
	liPathRE = regexp.MustCompile(`(?i)^(?:in|pub)/([^/]+)`)
)

func NormalizeHandle(input, fallback string) (typ, handle string, ok bool) {
	s := strings.TrimSpace(input)
	if s == "" {
		return "", "", false
	}
	if m := urlRE.FindStringSubmatch(s); m != nil {
		host := strings.ToLower(m[1])
		path := m[2]
		if i := strings.IndexAny(path, "?#"); i >= 0 {
			path = path[:i]
		}
		path = strings.TrimRight(path, "/")
		if host == "linkedin.com" {
			pm := liPathRE.FindStringSubmatch(path)
			if pm == nil {
				return "", "", false
			}
			slug := pm[1]
			if d, err := url.PathUnescape(slug); err == nil {
				slug = d
			}
			slug = strings.ToLower(slug)
			return check("linkedin", slug)
		}
		h, _, _ := strings.Cut(path, "/")
		return check("x", strings.ToLower(strings.TrimPrefix(h, "@")))
	}
	s = strings.ToLower(strings.TrimPrefix(s, "@"))
	if fallback == "linkedin" {
		return check("linkedin", s)
	}
	return check("x", s)
}

func check(typ, h string) (string, string, bool) {
	re := xRE
	if typ == "linkedin" {
		re = liRE
	}
	if !re.MatchString(h) {
		return "", "", false
	}
	return typ, h, true
}
