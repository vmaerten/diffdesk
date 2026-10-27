package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestIntelligenceRevisionRoutesUseIsolatedFiles(t *testing.T) {
	m, _, _ := fakeServers(t, "ok")
	runtime := NewRuntime(nil)
	runtime.lsp = m
	repo := fixture(t)
	writeFixture(t, repo.Path, "main.go", "package main\n\nfunc main() {\n\tvar s Store\n\ts.Mutate()\n}\n")
	writeFixture(t, repo.Path, "store.go", "package main\n\ntype Store struct{ Branch int }\n\nfunc (s *Store) Mutate() {}\n")
	writeFixture(t, repo.Path, "caller.go", "package main\n\nfunc g(s *Store) { s.Mutate() }\n")
	gitFixture(t, repo.Path, "add", "main.go", "store.go", "caller.go")
	gitFixture(t, repo.Path, "commit", "-qm", "reviewed symbols")
	revision := gitFixture(t, repo.Path, "rev-parse", "HEAD")
	// The user's checkout holds a different token and uncommitted work.
	writeFixture(t, repo.Path, "main.go", "package main\n\nfunc unrelated() {}\n")
	writeFixture(t, repo.Path, "store.go", "package main\n\ntype Store struct{ Local int }\n")
	before := gitFixture(t, repo.Path, "status", "--porcelain=v1")
	entry, err := runtime.Open(context.Background(), repo.Path)
	if err != nil {
		t.Fatal(err)
	}
	get := func(route string, query url.Values) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		runtime.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1/r/"+entry.ID+"/api/"+route+"?"+query.Encode(), nil))
		return w
	}
	params := url.Values{"revision": {revision}, "path": {"main.go"}, "line": {"5"}, "character": {"3"}, "token": {"Mutate"}}
	requireStatus(t, get("lsp", params), 200)
	if len(m.workspaces) != 0 {
		t.Fatal("disabled intelligence created a worktree")
	}
	_ = m.configure(lspConfig{Enabled: true})
	for _, invalid := range []string{"feature", "--help", strings.Repeat("0", 40)} {
		status := 400
		if len(invalid) == 40 {
			status = 422
		}
		requireStatus(t, get("lsp/symbol", url.Values{"revision": {invalid}, "path": {"main.go"}, "line": {"5"}, "character": {"3"}, "token": {"Mutate"}}), status)
	}
	w := get("lsp/symbol", params)
	requireStatus(t, w, 200)
	var symbol symbolAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &symbol); err != nil {
		t.Fatal(err)
	}
	if len(symbol.Definitions) == 0 || symbol.Definitions[0].Path != "store.go" || symbol.Definitions[0].Snippet == nil || !strings.Contains(strings.Join(symbol.Definitions[0].Snippet.Lines, "\n"), "Branch int") {
		t.Fatalf("definition did not come from the revision: %s", w.Body.String())
	}
	w = get("lsp/references", params)
	requireStatus(t, w, 200)
	var refs referencesAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &refs); err != nil {
		t.Fatal(err)
	}
	if len(refs.References) != 2 || !strings.Contains(refs.References[1].Text, "Mutate") {
		t.Fatalf("wrong revision references: %s", w.Body.String())
	}
	params.Del("revision")
	requireStatus(t, get("lsp/symbol", params), 409)
	if after := gitFixture(t, repo.Path, "status", "--porcelain=v1"); after != before {
		t.Fatalf("user checkout changed: %s -> %s", before, after)
	}
	if head := gitFixture(t, repo.Path, "rev-parse", "HEAD"); head != revision {
		t.Fatal("user's branch moved")
	}
	params.Set("revision", revision)
	w = get("lsp", params)
	requireStatus(t, w, 200)
	var status lspStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.Workspace == nil || status.Workspace.Kind != "revision" || status.Workspace.Revision != revision || status.Workspace.Path == repo.Path {
		t.Fatalf("missing isolated workspace status: %s", w.Body.String())
	}
	copyPath := status.Workspace.Path
	// Moving the branch must not change the already displayed revision.
	writeFixture(t, repo.Path, "store.go", "package main\n\ntype Store struct{ NewBranch int }\n")
	gitFixture(t, repo.Path, "add", "store.go")
	gitFixture(t, repo.Path, "commit", "-qm", "advance the branch")
	w = get("lsp/symbol", params)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), "NewBranch") || !strings.Contains(w.Body.String(), "Branch int") {
		t.Fatalf("a moved branch changed a pinned answer: %s", w.Body.String())
	}
	m.close()
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatalf("isolated checkout was not removed: %v", err)
	}
	if listed := gitFixture(t, repo.Path, "worktree", "list", "--porcelain"); strings.Contains(listed, "diffdesk-intelligence-") {
		t.Fatalf("worktree registration was left behind: %s", listed)
	}
}

func TestIntelligenceWorkspacesReuseCopiesAndCheckoutServers(t *testing.T) {
	m, _, _ := fakeServers(t, "ok")
	_ = m.configure(lspConfig{Enabled: true})
	repo := fixture(t)
	writeFixture(t, repo.Path, "main.go", "package main\n\nfunc main() {\n\tvar s Store\n\ts.Mutate()\n}\n")
	gitFixture(t, repo.Path, "add", "main.go")
	gitFixture(t, repo.Path, "commit", "-qm", "symbols")
	revision := gitFixture(t, repo.Path, "rev-parse", "HEAD")
	// The server exists only in the original checkout, outside the commit.
	writeFixture(t, repo.Path, "tools/fakels", "#!/bin/sh\nexec \"$GHL_FAKE_BINARY\" -test.run='^TestFakeLanguageServer$'\n")
	if err := os.Chmod(filepath.Join(repo.Path, "tools/fakels"), 0o755); err != nil {
		t.Fatal(err)
	}
	m.languages[0].Servers = []languageServer{{Name: "fakels", Choice: "fakels", checkout: "tools/fakels"}}
	hooks := t.TempDir()
	marker := filepath.Join(hooks, "ran")
	t.Setenv("GHL_HOOK_MARKER", marker)
	writeFixture(t, hooks, "post-checkout", "#!/bin/sh\n/usr/bin/touch \"$GHL_HOOK_MARKER\"\n")
	if err := os.Chmod(filepath.Join(hooks, "post-checkout"), 0o755); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, repo.Path, "config", "core.hooksPath", hooks)
	paths := make(chan string, 8)
	var jobs sync.WaitGroup
	for range 8 {
		jobs.Add(1)
		go func() {
			defer jobs.Done()
			copy, err := m.workspace(context.Background(), repo, revision)
			if err != nil {
				t.Error(err)
				return
			}
			paths <- copy.Path
		}()
	}
	jobs.Wait()
	close(paths)
	var root string
	for path := range paths {
		if root != "" && root != path {
			t.Fatal("concurrent requests created different copies")
		}
		root = path
	}
	if root == "" || len(m.workspaces) != 1 {
		t.Fatal("missing shared revision copy")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("preparing a revision ran the user's checkout hook")
	}
	client, err := m.client(context.Background(), root, "go")
	if err != nil {
		t.Fatal(err)
	}
	if client.server.Path != filepath.Join(repo.Path, "tools/fakels") {
		t.Fatalf("wrong server executable: %s", client.server.Path)
	}
	if _, err := os.Stat(filepath.Join(root, "tools/fakels")); !os.IsNotExist(err) {
		t.Fatal("untracked checkout files leaked into the revision")
	}
}
