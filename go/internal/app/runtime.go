package app

import (
	"context"
	"crypto/sha1"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

func statePath(gitDir string) string {
	return filepath.Join(gitDir, "ghl", "state.json")
}

func storeFor(repo Repository) *Store {
	return &Store{path: statePath(repo.GitDir)}
}

func repoID(path string) string {
	hash := fmt.Sprintf("%x", sha1.Sum([]byte(path)))
	return filepath.Base(path) + "-" + hash[:7]
}

// Registered is a repository the runtime serves, under /r/<ID>.
type Registered struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type runtimeHealth struct {
	BuildInfo
	PID   int          `json:"pid"`
	Repos []Registered `json:"repos"`
}

// Runtime serves the review API of each registered repository, and the UI
// from its assets. Selections belong to URLs, so registering a checkout never
// changes another tab's base.
type Runtime struct {
	mu     sync.Mutex
	assets fs.FS
	repos  map[string]*Server
}

// NewRuntime serves the UI from assets; nil serves the API alone.
func NewRuntime(assets fs.FS) *Runtime {
	return &Runtime{assets: assets, repos: make(map[string]*Server)}
}

// Open registers the repository containing path.
func (s *Runtime) Open(ctx context.Context, path string) (Registered, error) {
	repo, err := openRepository(ctx, path)
	if err != nil {
		return Registered{}, err
	}
	return s.register(repo), nil
}

func (s *Runtime) register(repo Repository) Registered {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := repoID(repo.Path)
	if s.repos[id] == nil {
		s.repos[id] = &Server{repo: repo, id: id, assets: s.assets, store: storeFor(repo)}
	}
	return Registered{id, repo.Path}
}

func (s *Runtime) servedLocked() []Registered {
	result := make([]Registered, 0, len(s.repos))
	for id, server := range s.repos {
		result = append(result, Registered{id, server.repo.Path})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (s *Runtime) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedRequest(w, r) {
		return
	}
	switch {
	case r.URL.Path == "/api/health" && r.Method == "GET":
		s.mu.Lock()
		repos := s.servedLocked()
		s.mu.Unlock()
		reply(w, 200, runtimeHealth{BuildInfo: buildInfo(), PID: os.Getpid(), Repos: repos})
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
		entry, err := s.Open(r.Context(), body.Path)
		if err != nil {
			fail(w, 422, err)
			return
		}
		reply(w, 200, entry)
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
			server.ServeHTTP(w, r)
		} else if r.Method == "GET" && (r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/assets/")) {
			path := strings.TrimPrefix(r.URL.Path, "/")
			if path == "" {
				path = "index.html"
			}
			(&Server{assets: s.assets}).static(w, r, path)
		} else {
			fail(w, 404, fmt.Errorf("not found"))
		}
	}
}

// Serve answers on listener until ctx ends, then cancels Git work and drains requests.
func (s *Runtime) Serve(ctx context.Context, listener net.Listener) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	server := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second,
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
	}
	cancel() // Cancel Git work as well as waiting for HTTP handlers to drain.
	shutdown, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	return server.Shutdown(shutdown)
}
