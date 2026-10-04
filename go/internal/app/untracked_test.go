package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
)

func TestUntrackedScopeAndSources(t *testing.T) {
	r := fixture(t)
	ctx := context.Background()
	writeFixture(t, r.Path, ".gitignore", "ignored/\n")
	writeFixture(t, r.Path, "ignored/hidden.txt", "ignored\n")
	for path, data := range map[string]string{
		"nested/space é.txt": "first\nsecond\n", "tab\tline\n.txt": "no newline",
		"-option.txt": "option\n", "empty.txt": "", "executable.sh": "#!/bin/sh\n",
		"untracked.bin": "\x00binary", "nested/.gitattributes": "*.txt -diff\n",
	} {
		writeFixture(t, r.Path, path, data)
	}
	if err := os.Chmod(filepath.Join(r.Path, "executable.sh"), 0700); err != nil {
		t.Fatal(err)
	}
	beforeIndex, err := os.ReadFile(filepath.Join(r.GitDir, "index"))
	if err != nil {
		t.Fatal(err)
	}
	defaultReview, err := r.Resolve(ctx, Selection{Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	paths, err := r.git(ctx, 1<<20, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Split(strings.TrimSuffix(string(paths), "\x00"), "\x00")
	if !reflect.DeepEqual(defaultReview.Untracked, want) || defaultReview.UntrackedIncluded || defaultReview.Totals.Files != 6 {
		t.Fatalf("default scope: %+v %v", defaultReview.Totals, defaultReview.Untracked)
	}
	review, err := r.Resolve(ctx, Selection{Base: "main", IncludeUntracked: true})
	if err != nil {
		t.Fatal(err)
	}
	if !review.UntrackedIncluded || review.Totals.Files != 6+len(want) {
		t.Fatalf("included scope: %+v", review.Totals)
	}
	for _, path := range want {
		f := statFor(t, review, path)
		if f.Status != "untracked" || f.Hash == nil {
			t.Fatalf("untracked metadata: %+v", f)
		}
		if f.Binary {
			if _, err := review.Context(ctx, path, *f.Hash); err == nil {
				t.Fatal("binary context accepted")
			}
			continue
		}
		files, err := review.Context(ctx, path, *f.Hash)
		if err != nil {
			t.Fatalf("%q context: %v", path, err)
		}
		if files.OldFile.Contents != "" || files.NewFile.Name != path {
			t.Fatalf("%q sources: %+v", path, files)
		}
	}
	if !statFor(t, review, "nested/space é.txt").Binary || !statFor(t, review, "untracked.bin").Binary || !strings.Contains(review.Patch, "new file mode 100755") {
		t.Fatal("attributes, binary detection or executable mode lost")
	}
	afterIndex, err := os.ReadFile(filepath.Join(r.GitDir, "index"))
	if err != nil || string(afterIndex) != string(beforeIndex) {
		t.Fatal("review modified the user's index")
	}
	for _, selection := range []Selection{
		{Base: "main", Committed: true, IncludeUntracked: true},
		{Base: "main", Target: "feature", IncludeUntracked: true},
		{Base: "main", Commit: "HEAD", IncludeUntracked: true},
	} {
		review, err := r.Resolve(ctx, selection)
		if err != nil || len(review.Untracked) != 0 || review.UntrackedIncluded {
			t.Fatalf("revision included checkout files: %+v %v", selection, err)
		}
	}
}

func TestUntrackedDefaultDoesNotReadLargeOrUnsafeFiles(t *testing.T) {
	r := fixture(t)
	for i := 0; i < 500; i++ {
		writeFixture(t, r.Path, fmt.Sprintf("many/%04d.txt", i), "small\n")
	}
	large := filepath.Join(r.Path, "large.txt")
	f, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate(maxTextBytes + 1)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("context.txt", filepath.Join(r.Path, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(r.Path, "pipe"), 0600); err != nil {
		t.Fatal(err)
	}
	review, err := r.Resolve(context.Background(), Selection{Base: "main"})
	if err != nil || len(review.Untracked) != 503 || review.UntrackedIncluded || review.Totals.Files != 6 {
		t.Fatalf("large default listing: %v %v", review, err)
	}
	for _, path := range []string{"large.txt", "link.txt", "pipe", "disappeared.txt"} {
		if _, _, err := r.untrackedPatch(context.Background(), []string{path}); err == nil {
			t.Fatalf("accepted unsafe or unavailable %s", path)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := r.untrackedPatch(ctx, []string{"untracked.txt"}); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestUntrackedGitErrorsAreNotDifferences(t *testing.T) {
	r := fixture(t)
	for _, args := range [][]string{
		{"diff", "--no-index", "--", "/dev/null", "missing.txt"},
		{"diff", "--invalid-diff-option"},
	} {
		if _, err := r.gitOutput(context.Background(), 1024, true, args...); err == nil {
			t.Fatalf("Git error treated as a diff: %v", args)
		}
	}
	if _, err := r.gitOutput(context.Background(), 1, true, "diff", "--no-index", "--", "/dev/null", "untracked.txt"); err == nil {
		t.Fatal("truncated Git output accepted as a complete diff")
	}
}

func TestUntrackedNestedRepositoryDoesNotAbortReview(t *testing.T) {
	for _, linked := range []bool{false, true} {
		t.Run(fmt.Sprintf("linked-worktree=%t", linked), func(t *testing.T) {
			r := fixture(t)
			path := filepath.Join(r.Path, ".claude/worktrees/comments-ui")
			if linked {
				source := fixture(t)
				gitFixture(t, source.Path, "worktree", "add", "--detach", path, "HEAD")
			} else {
				if err := os.MkdirAll(path, 0700); err != nil {
					t.Fatal(err)
				}
				gitFixture(t, path, "init", "-q", "-b", "main")
			}
			writeFixture(t, path, "private.txt", "nested repository content\n")
			paths := gitFixture(t, r.Path, "ls-files", "--others", "--exclude-standard")
			if !strings.Contains(paths, ".claude/worktrees/comments-ui/") {
				t.Fatalf("fixture did not reproduce Git's directory entry: %s", paths)
			}
			review, err := r.Resolve(context.Background(), Selection{Base: "main", IncludeUntracked: true})
			if err != nil {
				t.Fatalf("including an embedded repository aborted the review: %v", err)
			}
			if review.Totals.Files != 7 || statFor(t, review, "untracked.txt").Status != "untracked" {
				t.Fatalf("ordinary tracked/untracked files were lost: %+v", review.Totals)
			}
			if strings.Contains(review.Patch, "nested repository content") || strings.Contains(strings.Join(review.Untracked, "\n"), ".claude/worktrees/comments-ui") {
				t.Fatal("a nested repository was treated as an ordinary untracked file")
			}
		})
	}
}

func TestUntrackedCommentViewedAndDisappearance(t *testing.T) {
	s := testServer(t)
	const query = "?base=main&untracked"
	read := func(query string) struct {
		Files    []FileStat      `json:"files"`
		Viewed   ViewedMap       `json:"viewed"`
		Comments []ServedComment `json:"comments"`
	} {
		t.Helper()
		w := api(t, s, "GET", "diff"+query, nil)
		requireStatus(t, w, 200)
		var payload struct {
			Files    []FileStat      `json:"files"`
			Viewed   ViewedMap       `json:"viewed"`
			Comments []ServedComment `json:"comments"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	review, err := s.repo.Resolve(context.Background(), Selection{Base: "main", IncludeUntracked: true})
	if err != nil {
		t.Fatal(err)
	}
	f := statFor(t, review, "untracked.txt")
	c := Comment{ID: "untracked", Path: f.Path, Side: "additions", Start: 1, End: 1, Body: "new file", Range: review.Range}
	requireStatus(t, api(t, s, "POST", "comments"+query, c), 200)
	c.ID, c.Side = "invalid-old-side", "deletions"
	requireStatus(t, api(t, s, "POST", "comments"+query, c), 400)
	requireStatus(t, api(t, s, "POST", "viewed", map[string]any{"range": review.Range, "path": f.Path, "hash": f.Hash, "viewed": true}), 200)
	s.store = &Store{path: s.store.path, gitDir: s.repo.GitDir}
	initial := read(query)
	if initial.Viewed[f.Path] == nil || len(initial.Comments) != 1 || !reflect.DeepEqual(initial.Comments[0].Anchor, []string{"excluded"}) {
		t.Fatal("restart lost untracked state")
	}
	contextQuery := query + "&path=" + url.QueryEscape(f.Path) + "&hash=" + *f.Hash
	requireStatus(t, api(t, s, "GET", "diff-files"+contextQuery, nil), 200)
	writeFixture(t, s.repo.Path, f.Path, "changed\n")
	requireStatus(t, api(t, s, "GET", "diff-files"+contextQuery, nil), 409)
	updated := read(query)
	if len(updated.Viewed) != 0 || !updated.Comments[0].Stale || updated.Comments[0].Code[0] != "changed" {
		t.Fatal("untracked change did not invalidate state")
	}
	requireStatus(t, api(t, s, "PATCH", "comments"+query, map[string]string{"id": "untracked", "body": "edited"}), 200)
	outside := read("?base=main")
	if len(outside.Comments) != 1 || len(outside.Comments[0].Code) != 0 || outside.Comments[0].Body != "edited" || outside.Comments[0].CreatedAt != initial.Comments[0].CreatedAt {
		t.Fatal("excluded comment lost its identity")
	}
	if err := os.Remove(filepath.Join(s.repo.Path, f.Path)); err != nil {
		t.Fatal(err)
	}
	requireStatus(t, api(t, s, "GET", "diff-files"+contextQuery, nil), 409)
	if gone := read(query); len(gone.Comments) != 1 || len(gone.Comments[0].Code) != 0 || gone.Comments[0].Anchor[0] != "excluded" {
		t.Fatal("disappearance lost historical comment")
	}
	requireStatus(t, api(t, s, "DELETE", "comments?id=untracked", nil), 200)
	if len(read(query).Comments) != 0 {
		t.Fatal("untracked comment deletion failed")
	}
}
