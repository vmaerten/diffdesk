package app

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeSelectBranchWorktree(t *testing.T) {
	repo := fixture(t)
	linkedPath := filepath.Join(t.TempDir(), "linked worktree é\nsecond line")
	gitFixture(t, repo.Path, "worktree", "add", "-q", "-b", "linked/feature", linkedPath, "main")
	linkedPath, err := filepath.EvalSymlinks(linkedPath)
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, linkedPath, "linked.txt", "committed\n")
	gitFixture(t, linkedPath, "add", "linked.txt")
	gitFixture(t, linkedPath, "commit", "-qm", "linked change")
	writeFixture(t, linkedPath, "linked.txt", "local worktree edit\n")
	writeFixture(t, linkedPath, "staged.txt", "staged worktree edit\n")
	gitFixture(t, linkedPath, "add", "staged.txt")
	writeFixture(t, linkedPath, "untracked.txt", "untracked worktree edit\n")
	gitFixture(t, repo.Path, "worktree", "lock", "--reason", "active session", linkedPath)
	runtime, err := newRuntime(Options{}, "worktree-test", false)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := runtime.register(repo)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		runtime.ServeHTTP(w, httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(string(raw))))
		return w
	}
	selectBranch := func(id, branch string) *registeredRepo {
		t.Helper()
		w := request("POST", "/r/"+url.PathEscape(id)+"/api/worktree", map[string]string{"branch": branch})
		requireStatus(t, w, 200)
		var response struct {
			Repo *registeredRepo `json:"repo"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response.Repo
	}
	linked := selectBranch(entry.ID, "linked/feature")
	if linked == nil || linked.ID != repoID(linkedPath) || linked.Path != linkedPath || linked.ID == entry.ID {
		t.Fatalf("wrong worktree: %+v", linked)
	}
	w := request("GET", "/r/"+url.PathEscape(linked.ID)+"/api/diff?base=main&untracked", nil)
	requireStatus(t, w, 200)
	var diff struct {
		Patch      string     `json:"patch"`
		Comparison Comparison `json:"comparison"`
		Range      string     `json:"range"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Comparison.After != nil {
		t.Fatal("worktree opened as a committed revision")
	}
	for _, text := range []string{"+local worktree edit", "+staged worktree edit", "+untracked worktree edit"} {
		if !strings.Contains(diff.Patch, text) {
			t.Fatalf("missing %q in %s", text, diff.Patch)
		}
	}
	comment := Comment{ID: "linked-comment", Path: "linked.txt", Side: "additions", Start: 1, End: 1, Range: diff.Range, Body: "worktree-specific comment"}
	requireStatus(t, request("POST", "/r/"+url.PathEscape(linked.ID)+"/api/comments?base=main", comment), 200)
	for _, id := range []string{entry.ID, linked.ID} {
		w := request("GET", "/r/"+url.PathEscape(id)+"/api/diff?base=main", nil)
		requireStatus(t, w, 200)
		var payload struct {
			Comments []ServedComment `json:"comments"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if id == entry.ID && len(payload.Comments) != 0 {
			t.Fatal("linked worktree comment leaked into original checkout")
		}
		if id == linked.ID && (len(payload.Comments) != 1 || payload.Comments[0].ID != comment.ID) {
			t.Fatal("linked worktree comment was lost")
		}
	}
	back := selectBranch(linked.ID, "feature")
	if back == nil || back.ID != entry.ID {
		t.Fatalf("cannot return to original worktree: %+v", back)
	}
	if got := selectBranch(entry.ID, "main"); got != nil {
		t.Fatalf("branch without worktree: %+v", got)
	}
	if got := selectBranch(entry.ID, "HEAD"); got != nil {
		t.Fatalf("revision treated as a branch: %+v", got)
	}
	// A directory replaced by an unrelated repository must not be opened, even
	// if it happens to have a branch with the same name as the stale worktree.
	replacedPath := filepath.Join(t.TempDir(), "replaced")
	gitFixture(t, repo.Path, "worktree", "add", "-q", "-b", "replaced", replacedPath, "main")
	if err := os.RemoveAll(replacedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(replacedPath, 0700); err != nil {
		t.Fatal(err)
	}
	gitFixture(t, replacedPath, "init", "-q", "-b", "replaced")
	if got := selectBranch(entry.ID, "replaced"); got != nil {
		t.Fatalf("opened unrelated repository: %+v", got)
	}
	gitFixture(t, repo.Path, "worktree", "unlock", linkedPath)
	if err := os.RemoveAll(linkedPath); err != nil {
		t.Fatal(err)
	}
	if got := selectBranch(entry.ID, "linked/feature"); got != nil {
		t.Fatalf("prunable worktree opened: %+v", got)
	}
	for _, branch := range []string{"", "-invalid", "missing", "linked/feature\nextra"} {
		w := request("POST", "/r/"+entry.ID+"/api/worktree", map[string]string{"branch": branch})
		if w.Code != 400 && w.Code != 422 {
			t.Fatalf("invalid branch %q: HTTP %d", branch, w.Code)
		}
	}
}
