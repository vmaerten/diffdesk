package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type revisionWorkspace struct {
	source Repository
	repo   Repository
	folder string
}

type intelligenceWorkspace struct {
	Kind     string `json:"kind"`
	Revision string `json:"revision,omitempty"`
	Path     string `json:"path,omitempty"`
}

// workspace materializes one immutable revision without changing the user's
// checkout. Detached worktrees also keep its commit alive while it is reviewed.
func (m *languageServers) workspace(ctx context.Context, source Repository, revision string) (Repository, error) {
	if !objectIDRE.MatchString(revision) {
		return Repository{}, fmt.Errorf("Expected a full commit ID")
	}
	m.workspaceMu.Lock()
	defer m.workspaceMu.Unlock()
	m.mu.Lock()
	closed, enabled := m.closed, m.config.Enabled
	m.mu.Unlock()
	if closed {
		return Repository{}, errLSPClosed
	}
	if !enabled {
		return Repository{}, errLSPDisabled
	}
	key := source.Path + ":" + revision
	if workspace, ok := m.workspaces[key]; ok {
		return workspace.repo, nil
	}
	commit, err := source.text(ctx, "rev-parse", "--verify", revision+"^{commit}")
	if err != nil || commit != revision {
		return Repository{}, fmt.Errorf("The displayed commit is no longer available")
	}
	folder, err := os.MkdirTemp("", "diffdesk-intelligence-")
	if err != nil {
		return Repository{}, err
	}
	workspace := revisionWorkspace{source: source, folder: folder, repo: Repository{Path: filepath.Join(folder, "checkout")}}
	// A review must not run post-checkout hooks or update submodules.
	_, err = source.git(ctx, 1<<20, "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", "worktree", "add", "--quiet", "--detach", workspace.repo.Path, revision)
	if err == nil {
		workspace.repo, err = openRepository(ctx, workspace.repo.Path)
	}
	if err != nil {
		workspace.remove()
		return Repository{}, fmt.Errorf("Could not prepare the isolated revision: %w", err)
	}
	m.workspaces[key] = workspace
	m.mu.Lock()
	m.origins[workspace.repo.Path] = source.Path
	m.mu.Unlock()
	return workspace.repo, nil
}

func (w revisionWorkspace) remove() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _ = w.source.git(ctx, 1<<20, "-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", w.repo.Path)
	_ = os.RemoveAll(w.folder)
}

// Called after the language servers stop, so none still reads a removed copy.
func (m *languageServers) closeWorkspaces() {
	m.workspaceMu.Lock()
	defer m.workspaceMu.Unlock()
	for key, workspace := range m.workspaces {
		workspace.remove()
		delete(m.workspaces, key)
	}
}

func (m *languageServers) origin(root string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if origin := m.origins[root]; origin != "" {
		return origin
	}
	return root
}

// Servers installed in the original checkout can analyze an isolated revision
// too. Project source and dependencies are always resolved in the revision copy.
func (m *languageServers) findServer(root string, l language, env []string, choice string) *resolvedServer {
	server := l.find(root, env, choice)
	if server != nil && server.Origin == "checkout" {
		return server
	}
	if origin := m.origin(root); origin != root {
		return l.find(origin, env, choice)
	}
	return server
}

func (s *Server) intelligenceScope(ctx context.Context, revision string) (*Server, error) {
	if revision == "" {
		return s, nil
	}
	repo, err := s.lsp.workspace(ctx, s.repo, revision)
	if err != nil {
		return nil, err
	}
	return &Server{repo: repo, lsp: s.lsp}, nil
}
