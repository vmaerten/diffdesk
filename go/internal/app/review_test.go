package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Compare takes the base as given, without Resolve's automatic base.
func (r Repository) Compare(ctx context.Context, base string, committed bool) (*Review, error) {
	return r.compare(ctx, Selection{Base: base, Committed: committed}, false)
}

func gitFixture(t *testing.T, path string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", path}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}
func writeFixture(t *testing.T, root, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(root, path)), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, path), []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
}
func fixture(t *testing.T) Repository {
	t.Helper()
	path := t.TempDir()
	gitFixture(t, path, "init", "-q", "-b", "main")
	gitFixture(t, path, "config", "user.name", "Fixture")
	gitFixture(t, path, "config", "user.email", "fixture@example.invalid")
	gitFixture(t, path, "config", "commit.gpgsign", "false")
	gitFixture(t, path, "config", "core.hooksPath", "/dev/null")
	var lines strings.Builder
	for i := 1; i <= 100; i++ {
		fmt.Fprintf(&lines, "line %d\n", i)
	}
	writeFixture(t, path, "context.txt", lines.String())
	writeFixture(t, path, "old name é.txt", "rename\n")
	writeFixture(t, path, "deleted.txt", "delete\n")
	writeFixture(t, path, "binary.bin", "\x00old")
	gitFixture(t, path, "add", ".")
	gitFixture(t, path, "commit", "-qm", "base")
	gitFixture(t, path, "checkout", "-qb", "feature")
	writeFixture(t, path, "context.txt", strings.Replace(lines.String(), "line 10\n", "committed 10\n", 1))
	gitFixture(t, path, "mv", "old name é.txt", "renamed é.txt")
	if err := os.Remove(filepath.Join(path, "deleted.txt")); err != nil {
		t.Fatal(err)
	}
	writeFixture(t, path, "added.txt", "added\n")
	gitFixture(t, path, "add", "-A")
	gitFixture(t, path, "commit", "-qm", "feature")
	writeFixture(t, path, "staged.txt", "staged\n")
	gitFixture(t, path, "add", "staged.txt")
	writeFixture(t, path, "context.txt", strings.Replace(strings.Replace(lines.String(), "line 10\n", "committed 10\n", 1), "line 80\n", "working 80\n", 1))
	writeFixture(t, path, "binary.bin", "\x00new")
	writeFixture(t, path, "untracked.txt", "excluded\n")
	r, err := openRepository(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func compare(t *testing.T, r Repository, committed bool) *Review {
	t.Helper()
	review, err := r.Compare(context.Background(), "main", committed)
	if err != nil {
		t.Fatal(err)
	}
	return review
}
func statFor(t *testing.T, review *Review, path string) FileStat {
	t.Helper()
	for _, f := range review.Files {
		if f.Path == path {
			return f
		}
	}
	t.Fatalf("missing %s", path)
	return FileStat{}
}
func TestComparison(t *testing.T) {
	r := fixture(t)
	review := compare(t, r, false)
	if review.Comparison.After != nil || review.Range != "main..feature" || review.Totals != (Totals{Files: 6, Additions: 4, Deletions: 3}) {
		t.Fatalf("unexpected comparison: %+v %+v", review.Comparison, review.Totals)
	}
	for path, status := range map[string]string{"context.txt": "modified", "renamed é.txt": "renamed", "deleted.txt": "deleted", "added.txt": "added", "staged.txt": "added"} {
		f := statFor(t, review, path)
		if f.Status != status || f.Hash == nil {
			t.Errorf("%s: %+v", path, f)
		}
	}
	if !statFor(t, review, "binary.bin").Binary {
		t.Fatal("binary file missing")
	}
	for _, f := range review.Files {
		if f.Path == "untracked.txt" {
			t.Fatal("untracked included")
		}
	}
	committed := compare(t, r, true)
	if committed.Comparison.After == nil || committed.Totals.Files != 4 {
		t.Fatalf("committed comparison: %+v", committed.Totals)
	}
	if got := gitFixture(t, r.Path, "diff", committed.Comparison.Before, *committed.Comparison.After, "--no-color", "--no-ext-diff"); strings.TrimSpace(committed.Patch) != got {
		t.Fatal("patch differs from Git")
	}
	// A commit landing on the base after the fork stays out of the review.
	gitFixture(t, r.Path, "stash", "push", "-qu")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	writeFixture(t, r.Path, "base-only.txt", "new base commit\n")
	gitFixture(t, r.Path, "add", ".")
	gitFixture(t, r.Path, "commit", "-qm", "base moved")
	gitFixture(t, r.Path, "checkout", "-q", "feature")
	if newer := compare(t, r, true); newer.Patch != committed.Patch {
		t.Fatal("diff incorrectly includes new base work")
	}
}
func TestContextAndAnchors(t *testing.T) {
	ctx := context.Background()
	r := fixture(t)
	review := compare(t, r, false)
	f := statFor(t, review, "context.txt")
	files, err := review.Context(ctx, f.Path, *f.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(files.OldFile.Contents, "line 10\n") || !strings.Contains(files.NewFile.Contents, "working 80\n") || len(files.NewFile.CacheKey) != 64 {
		t.Fatal("incorrect versions")
	}
	for side, expected := range map[string]string{"deletions": "line 10", "additions": "committed 10"} {
		c := Comment{Path: f.Path, Side: side, Start: 10, End: 10}
		lines, err := review.Lines(ctx, c)
		if err != nil || strings.Join(lines, "") != expected {
			t.Fatalf("%s anchor: %v %v", side, lines, err)
		}
	}
	c := Comment{Path: f.Path, Side: "additions", Start: 90, End: 91, Anchor: []string{"line 90", "line 91"}}
	served := review.Comments(ctx, []Comment{c})[0]
	if served.Stale || strings.Join(served.Code, "|") != "line 90|line 91" {
		t.Fatalf("context anchor: %+v", served)
	}
	writeFixture(t, r.Path, f.Path, strings.Replace(files.NewFile.Contents, "line 90\n", "changed 90\n", 1))
	newer := compare(t, r, false)
	if _, err := newer.Context(ctx, f.Path, *f.Hash); err == nil || !strings.Contains(err.Error(), "refresh") {
		t.Fatal("stale fingerprint accepted")
	}
	if !newer.Comments(ctx, []Comment{c})[0].Stale {
		t.Fatal("changed comment not stale")
	}
	// A snapshot must reject changes even when they are outside displayed hunks.
	snapshot := compare(t, r, false)
	writeFixture(t, r.Path, f.Path, strings.Replace(files.NewFile.Contents, "line 95\n", "raced 95\n", 1))
	if _, err := snapshot.Context(ctx, f.Path, *statFor(t, snapshot, f.Path).Hash); err == nil {
		t.Fatal("raced bytes accepted")
	}
	out := Comment{Path: "outside.txt", Side: "additions", Start: 1, End: 1, Anchor: []string{"original"}}
	if served := newer.Comments(ctx, []Comment{out})[0]; served.Stale || len(served.Code) != 0 {
		t.Fatal("outside comment should remain neutral")
	}
	for _, path := range []string{"renamed é.txt", "added.txt", "deleted.txt"} {
		files, err := newer.Context(ctx, path, *statFor(t, newer, path).Hash)
		if err != nil {
			t.Fatal(err)
		}
		if path == "renamed é.txt" && files.OldFile != nil {
			t.Fatal("pure rename must hydrate as one file")
		}
	}
}

func TestEditedRename(t *testing.T) {
	r := fixture(t)
	gitFixture(t, r.Path, "mv", "context.txt", "context moved.txt")
	contents, err := os.ReadFile(filepath.Join(r.Path, "context moved.txt"))
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, r.Path, "context moved.txt", strings.Replace(string(contents), "line 50\n", "renamed 50\n", 1))
	gitFixture(t, r.Path, "add", "-A")
	gitFixture(t, r.Path, "commit", "-qm", "edited rename")
	review := compare(t, r, true)
	f := statFor(t, review, "context moved.txt")
	if f.Status != "renamed" {
		t.Fatalf("rename lost: %+v", f)
	}
	files, err := review.Context(context.Background(), f.Path, *f.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if files.OldFile == nil || files.OldFile.Name != "context.txt" || !strings.Contains(files.NewFile.Contents, "renamed 50") {
		t.Fatal("incorrect renamed versions")
	}
}
func TestPathsAndReadLimits(t *testing.T) {
	ctx := context.Background()
	r := fixture(t)
	for _, path := range []string{"space name.txt", "日本語.txt", "tab\tname.txt", "line\nname.txt", "has b/name.txt", "quote\"name.txt", "é\tname.txt"} {
		writeFixture(t, r.Path, path, "original\n")
		gitFixture(t, r.Path, "add", "--", path)
	}
	gitFixture(t, r.Path, "commit", "-qm", "names")
	for _, path := range []string{"space name.txt", "日本語.txt", "tab\tname.txt", "line\nname.txt", "has b/name.txt", "quote\"name.txt", "é\tname.txt"} {
		writeFixture(t, r.Path, path, "edited\n")
	}
	review := compare(t, r, false)
	for _, path := range []string{"space name.txt", "日本語.txt", "tab\tname.txt", "line\nname.txt", "has b/name.txt", "quote\"name.txt", "é\tname.txt"} {
		f := statFor(t, review, path)
		if f.Hash == nil {
			t.Fatalf("unparsed name %q", path)
		}
		if _, err := review.Context(ctx, path, *f.Hash); err != nil {
			t.Fatal(err)
		}
	}
	gitFixture(t, r.Path, "config", "core.quotepath", "false")
	unquoted := compare(t, r, false)
	if statFor(t, unquoted, "é\tname.txt").Hash == nil {
		t.Fatal("mixed Unicode/control path not parsed")
	}
	for _, path := range []string{"../escape", "/etc/passwd", ".git/config", "a/../context.txt", "a\\b", "a//b"} {
		if _, err := r.readText(ctx, nil, path); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	if err := os.Symlink("context.txt", filepath.Join(r.Path, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.readText(ctx, nil, "link"); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := os.Symlink(os.TempDir(), filepath.Join(r.Path, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	if _, err := r.readText(ctx, nil, "linked-dir/test"); err == nil {
		t.Fatal("symlink directory accepted")
	}
	writeFixture(t, r.Path, "invalid.txt", string([]byte{255}))
	if _, err := r.readText(ctx, nil, "invalid.txt"); err == nil {
		t.Fatal("invalid UTF-8 accepted")
	}
	if _, err := r.readText(ctx, nil, "binary.bin"); err == nil {
		t.Fatal("binary accepted")
	}
	if err := syscall.Mkfifo(filepath.Join(r.Path, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.readText(ctx, nil, "fifo"); err == nil {
		t.Fatal("special file accepted")
	}
	writeFixture(t, r.Path, "large.txt", strings.Repeat("x", maxTextBytes+1))
	if _, err := r.readText(ctx, nil, "large.txt"); err == nil || !strings.Contains(err.Error(), "20 MB") {
		t.Fatal("large worktree file accepted")
	}
	gitFixture(t, r.Path, "add", "large.txt")
	gitFixture(t, r.Path, "commit", "-qm", "large")
	head := gitFixture(t, r.Path, "rev-parse", "HEAD")
	if _, err := r.readText(ctx, &head, "large.txt"); err == nil || !strings.Contains(err.Error(), "20 MB") {
		t.Fatal("large blob accepted")
	}
}

func TestRunningGitCancellation(t *testing.T) {
	path := t.TempDir()
	if err := os.WriteFile(filepath.Join(path, "git"), []byte("#!/bin/sh\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", path)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := (Repository{Path: path}).git(ctx, 1024, "status")
	if err != context.DeadlineExceeded || time.Since(start) > time.Second {
		t.Fatalf("Git cancellation: %v after %s", err, time.Since(start))
	}
}

func TestRepositoryPathWithSpacesAndDetachedHead(t *testing.T) {
	r := fixture(t)
	newPath := filepath.Join(t.TempDir(), "repository é with spaces ")
	if err := os.Rename(r.Path, newPath); err != nil {
		t.Fatal(err)
	}
	r, err := openRepository(context.Background(), newPath)
	if err != nil {
		t.Fatal(err)
	}
	gitFixture(t, r.Path, "checkout", "--detach", "-q", "HEAD")
	review := compare(t, r, true)
	if review.Branch != nil || review.Range != "main..HEAD" {
		t.Fatal("incorrect detached review")
	}
}
func TestPatchFormatIgnoresUserConfig(t *testing.T) {
	ctx := context.Background()
	for _, setting := range [][2]string{{"diff.mnemonicPrefix", "true"}, {"diff.noprefix", "true"}, {"diff.srcPrefix", "x/"}, {"diff.suppressBlankEmpty", "true"}} {
		r := fixture(t)
		gitFixture(t, r.Path, "config", setting[0], setting[1])
		review, err := r.Resolve(ctx, Selection{Base: "main", IncludeUntracked: true})
		if err != nil {
			t.Fatal(err)
		}
		for _, f := range review.Files {
			if f.Hash == nil {
				t.Errorf("%s: %s has no patch section", setting[0], f.Path)
			}
		}
		// Context after a blank line, which suppressBlankEmpty prints without its space.
		writeFixture(t, r.Path, "blank.txt", "one\n\nthree\nfour\n")
		gitFixture(t, r.Path, "add", "blank.txt")
		gitFixture(t, r.Path, "commit", "-qm", "blank")
		writeFixture(t, r.Path, "blank.txt", "one\n\nthree\nFOUR\n")
		review, err = r.Resolve(ctx, Selection{Base: "HEAD"})
		if err != nil {
			t.Fatal(err)
		}
		lines, err := review.Lines(ctx, Comment{Path: "blank.txt", Side: "additions", Start: 3, End: 3})
		if err != nil || strings.Join(lines, "") != "three" {
			t.Errorf("%s: line 3 is %q: %v", setting[0], lines, err)
		}
	}
}
func TestInvalidComparisonsAndCancellation(t *testing.T) {
	r := fixture(t)
	ctx := context.Background()
	for _, base := range []string{"", "--help", "missing-ref", "HEAD\x00"} {
		if _, err := r.Compare(ctx, base, false); err == nil {
			t.Fatalf("accepted %q", base)
		}
	}
	for _, operation := range []string{"MERGE_HEAD", "rebase-merge", "CHERRY_PICK_HEAD"} {
		writeFixture(t, r.GitDir, operation, "in progress")
		if _, err := r.Compare(ctx, "main", false); err == nil || !strings.Contains(err.Error(), "scope") {
			t.Fatal("operation accepted")
		}
		if err := os.Remove(filepath.Join(r.GitDir, operation)); err != nil {
			t.Fatal(err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.git(cancelled, 1024, "status"); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
	path := t.TempDir()
	gitFixture(t, path, "init", "-q")
	empty, err := openRepository(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := empty.Compare(ctx, "HEAD", false); err == nil || !strings.Contains(err.Error(), "no commit") {
		t.Fatal("empty repo accepted")
	}
	if _, err := openRepository(ctx, t.TempDir()); err == nil {
		t.Fatal("non-repository accepted")
	}
}
