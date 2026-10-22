package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type registeredRepo struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type runtimeHealth struct {
	BuildInfo
	Go       bool             `json:"ghlGo"`
	PoC      bool             `json:"ghlGoPoc,omitempty"`
	Daemon   bool             `json:"daemon"`
	Revision string           `json:"revision"`
	Instance string           `json:"instance"`
	PID      int              `json:"pid"`
	Repos    []registeredRepo `json:"repos"`
}

// One registry owns the per-repository handlers and their stores. Selections
// belong to URLs, so registering a checkout never changes another tab's base.
type reviewRuntime struct {
	mu       sync.Mutex
	options  Options
	repos    map[string]*Server
	health   runtimeHealth
	lastSeen time.Time
	stopping bool
	stopped  chan struct{}
}

func newRuntime(options Options, revision string, daemon bool) (*reviewRuntime, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return nil, err
	}
	return &reviewRuntime{options: options, repos: make(map[string]*Server),
		health:   runtimeHealth{BuildInfo: buildInfo(), Go: true, Daemon: daemon, Revision: revision, Instance: hex.EncodeToString(bytes), PID: os.Getpid()},
		lastSeen: time.Now(), stopped: make(chan struct{})}, nil
}

func (s *reviewRuntime) register(repo Repository) (registeredRepo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopping {
		return registeredRepo{}, fmt.Errorf("Runtime is shutting down; retry registration")
	}
	id := repoID(repo.Path)
	if s.repos[id] == nil {
		s.repos[id] = &Server{repo: repo, id: id, assets: s.options.Assets, store: s.options.store(repo)}
	}
	return registeredRepo{id, repo.Path}, nil
}

func (s *reviewRuntime) servedLocked() []registeredRepo {
	result := make([]registeredRepo, 0, len(s.repos))
	for id, server := range s.repos {
		result = append(result, registeredRepo{id, server.repo.Path})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (s *reviewRuntime) stopLocked() {
	if !s.stopping {
		s.stopping = true
		close(s.stopped)
	}
}

func (s *reviewRuntime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedRequest(w, r) {
		return
	}
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		fail(w, 503, fmt.Errorf("Runtime is shutting down"))
		return
	}
	s.lastSeen = time.Now()
	s.mu.Unlock()
	switch {
	case r.URL.Path == "/api/health" && r.Method == "GET":
		s.mu.Lock()
		health := s.health
		health.Repos = s.servedLocked()
		s.mu.Unlock()
		reply(w, 200, health)
	case r.URL.Path == "/api/heartbeat" && r.Method == "POST":
		reply(w, 200, map[string]bool{"ok": true})
	case r.URL.Path == "/api/repos" && r.Method == "GET":
		s.mu.Lock()
		repos := s.servedLocked()
		s.mu.Unlock()
		reply(w, 200, map[string]any{"repos": repos})
	case r.URL.Path == "/api/repos" && r.Method == "POST":
		var body struct {
			Path string `json:"repoPath"`
		}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return
		}
		if body.Path == "" || !filepath.IsAbs(body.Path) {
			fail(w, 400, fmt.Errorf("repoPath must be an absolute repository path"))
			return
		}
		repo, err := openRepository(r.Context(), body.Path)
		if err != nil {
			fail(w, 422, err)
			return
		}
		entry, err := s.register(repo)
		if err != nil {
			fail(w, 503, err)
			return
		}
		reply(w, 200, entry)
	case r.URL.Path == "/api/shutdown" && r.Method == "POST":
		// The instance condition prevents a delayed upgrade request from stopping
		// a replacement runtime. Freeze registration before taking the handoff list.
		var body struct {
			Instance string `json:"instance"`
		}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return
		}
		s.mu.Lock()
		if body.Instance != s.health.Instance {
			s.mu.Unlock()
			fail(w, 409, fmt.Errorf("Runtime instance changed; probe it again"))
			return
		}
		repos := s.servedLocked()
		s.stopLocked()
		s.mu.Unlock()
		reply(w, 200, map[string]any{"ok": true, "repos": repos})
	default:
		segments := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(segments) >= 2 && segments[0] == "r" {
			s.mu.Lock()
			server := s.repos[segments[1]]
			s.mu.Unlock()
			if server == nil {
				fail(w, 404, fmt.Errorf("unknown repo: %s", segments[1]))
				return
			}
			if len(segments) == 4 && segments[2] == "api" && segments[3] == "worktree" && r.Method == "POST" {
				s.selectWorktree(w, r, server.repo)
				return
			}
			server.ServeHTTP(w, r)
		} else if r.Method == "GET" && (r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/")) {
			path := strings.TrimPrefix(r.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}
			(&Server{assets: s.options.Assets}).static(w, r, path)
		} else {
			fail(w, 404, fmt.Errorf("not found"))
		}
	}
}

// Resolve again at selection time so a stale picker cannot open a removed or
// detached worktree. Registering it preserves its own review state and locks.
func (s *reviewRuntime) selectWorktree(w http.ResponseWriter, r *http.Request, repo Repository) {
	var body struct {
		Branch string `json:"branch"`
	}
	if err := decode(w, r, &body); err != nil {
		fail(w, 400, err)
		return
	}
	if !validRef(body.Branch) {
		fail(w, 400, fmt.Errorf("A valid branch is required"))
		return
	}
	sha, err := repo.resolveRef(r.Context(), body.Branch)
	if err != nil || sha == "" {
		if err == nil {
			err = fmt.Errorf("Invalid target %q", body.Branch)
		}
		fail(w, 422, err)
		return
	}
	worktree, err := repo.branchWorktree(r.Context(), body.Branch)
	if err != nil {
		fail(w, 422, err)
		return
	}
	var entry *registeredRepo
	if worktree != nil {
		registered, err := s.register(*worktree)
		if err != nil {
			fail(w, 503, err)
			return
		}
		entry = &registered
	}
	reply(w, 200, map[string]any{"repo": entry})
}

func (s *reviewRuntime) watchIdle(ctx context.Context, idle time.Duration) {
	if idle <= 0 {
		return
	}
	tick := min(time.Second, idle)
	timer := time.NewTicker(tick)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stopped:
			return
		case <-timer.C:
			s.mu.Lock()
			if time.Since(s.lastSeen) >= idle {
				s.stopLocked()
			}
			s.mu.Unlock()
		}
	}
}

func serveHTTP(ctx context.Context, listener net.Listener, handler http.Handler, stop <-chan struct{}) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case err := <-done:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
	case <-stop:
	}
	cancel() // Cancel Git work as well as waiting for HTTP handlers to drain.
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	return server.Shutdown(shutdown)
}
