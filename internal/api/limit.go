package api

import (
	"sync"
	"time"
)

// limiter allows n events per window per key (sliding log; n is small).
type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cut := now.Add(-l.window)
	h := l.hits[key]
	i := 0
	for i < len(h) && !h[i].After(cut) {
		i++
	}
	h = h[i:]
	if len(h) >= l.n {
		l.hits[key] = h
		return false
	}
	l.hits[key] = append(h, now)
	return true
}

// counter is a fixed-window counter, cheap enough for a per-IP backstop.
type counter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	m      map[string]*bucket
}

type bucket struct {
	start time.Time
	count int
}

func newCounter(n int, window time.Duration) *counter {
	return &counter{n: n, window: window, m: map[string]*bucket{}}
}

func (c *counter) allow(key string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.m[key]
	if b == nil || now.Sub(b.start) >= c.window {
		b = &bucket{start: now}
		c.m[key] = b
	}
	b.count++
	return b.count <= c.n
}

// gc drops idle keys so the maps don't grow all day.
func (l *limiter) gc(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, h := range l.hits {
		if len(h) == 0 || now.Sub(h[len(h)-1]) > l.window {
			delete(l.hits, k)
		}
	}
}

func (c *counter) gc(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, b := range c.m {
		if now.Sub(b.start) > c.window {
			delete(c.m, k)
		}
	}
}
