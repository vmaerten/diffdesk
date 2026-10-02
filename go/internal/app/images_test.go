package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func imageFixture(t *testing.T) Repository {
	r := fixture(t)
	gitFixture(t, r.Path, "stash", "push", "-qu")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	writeFixture(t, r.Path, "modified.svg", "<svg>before</svg>")
	writeFixture(t, r.Path, "old é ~[1].png", "\x00rename")
	writeFixture(t, r.Path, "deleted.gif", "\x00deleted")
	gitFixture(t, r.Path, "add", ".")
	gitFixture(t, r.Path, "commit", "-qm", "base images")
	gitFixture(t, r.Path, "checkout", "-qb", "images")
	writeFixture(t, r.Path, "modified.svg", "<svg>committed</svg>")
	writeFixture(t, r.Path, "added.PNG", "\x00added")
	gitFixture(t, r.Path, "mv", "old é ~[1].png", "renamed é ~[1].png")
	gitFixture(t, r.Path, "rm", "-q", "deleted.gif")
	gitFixture(t, r.Path, "add", ".")
	gitFixture(t, r.Path, "commit", "-qm", "change images")
	writeFixture(t, r.Path, "modified.svg", "<svg>working</svg>")
	writeFixture(t, r.Path, "untracked.png", "\x00untracked")
	return r
}

func TestImageVersionsAndDisplayIdentity(t *testing.T) {
	r := imageFixture(t)
	ctx := context.Background()
	for _, selection := range []Selection{
		{Base: "main", IncludeUntracked: true}, {Base: "main", Committed: true},
		{Base: "main", Target: "images"}, {Base: "main", Commit: "HEAD"},
	} {
		review, err := r.Resolve(ctx, selection)
		if err != nil {
			t.Fatal(err)
		}
		textHash := *statFor(t, review, "modified.svg").Hash
		if err := review.attachImages(ctx, "repo"); err != nil {
			t.Fatal(err)
		}
		f := statFor(t, review, "modified.svg")
		if f.Image.Before == nil || f.Image.After == nil || *f.Hash == textHash {
			t.Fatal("image identity did not replace the patch hash")
		}
		want := "<svg>committed</svg>"
		if review.Comparison.After == nil {
			want = "<svg>working</svg>"
		}
		versions := map[string]*ImageVersion{
			"<svg>before</svg>": f.Image.Before, want: f.Image.After,
			"\x00rename": statFor(t, review, "renamed é ~[1].png").Image.Before,
		}
		for contents, version := range versions {
			uri, err := url.Parse(*version.URL)
			if err != nil {
				t.Fatal(err)
			}
			source, err := r.imageSource(ctx, uri.Query().Get("revision"), uri.Query().Get("path"))
			if err != nil {
				t.Fatal(err)
			}
			data, err := source.read(ctx)
			if err != nil || string(data) != contents || *version.Bytes != int64(len(data)) || version.Hash == "" {
				t.Fatalf("wrong image bytes: %s %v", data, err)
			}
		}
		if statFor(t, review, "added.PNG").Image.Before != nil || statFor(t, review, "deleted.gif").Image.After != nil {
			t.Fatal("missing sides were not preserved")
		}
		if selection.IncludeUntracked && statFor(t, review, "untracked.png").Image.Before != nil {
			t.Fatal("untracked image has an old side")
		}
	}
}

func TestImageHTTPAndUnsafeSources(t *testing.T) {
	s := testServer(t)
	s.repo = imageFixture(t)
	get := func(revision, path string) *httptest.ResponseRecorder {
		t.Helper()
		return api(t, s, "GET", "image?"+url.Values{"revision": {revision}, "path": {path}}.Encode(), nil)
	}
	for extension, mime := range map[string]string{
		"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
		"webp": "image/webp", "avif": "image/avif", "svg": "image/svg+xml", "ico": "image/x-icon", "bmp": "image/bmp",
	} {
		path := "nested/é file." + extension
		writeFixture(t, s.repo.Path, path, "\x00exact bytes")
		w := get("worktree", path)
		requireStatus(t, w, 200)
		if w.Body.String() != "\x00exact bytes" || w.Header().Get("Content-Type") != mime || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("unsafe or incorrect headers: %v", w.Header())
		}
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(s.repo.Path, "link.svg")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(s.repo.Path, "pipe.svg"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"../outside.svg", ".git/config.svg", "./modified.svg", "modified.svg/", "nested//é file.svg", "link.svg", "pipe.svg", "missing.png", "context.txt"} {
		requireStatus(t, get("worktree", path), 404)
	}
	writeFixture(t, s.repo.Path, ".png", "\x00hidden binary")
	requireStatus(t, get("worktree", ".png"), 404)
	for _, revision := range []string{"", "HEAD", "-option", strings.Repeat("0", 40)} {
		requireStatus(t, get(revision, "modified.svg"), 404)
	}
	if err := os.Remove(filepath.Join(s.repo.Path, "pipe.svg")); err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(s.repo.Path, "large.png")
	f, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	err = f.Truncate(maxTextBytes + 1)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, get("worktree", "large.png"), 404)
	w := api(t, s, "GET", "diff?base=main&untracked", nil)
	requireStatus(t, w, 200)
	var payload struct {
		Files []FileStat `json:"files"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for path, message := range map[string]string{"link.svg": "Symlink images are not previewed", "large.png": "Image exceeds the 20 MB preview limit"} {
		found := false
		for _, file := range payload.Files {
			if file.Path == path {
				found = file.Image.After.URL == nil && file.Image.After.Error == message && file.Hash != nil
			}
		}
		if !found {
			t.Fatalf("unavailable %s dropped from the diff", path)
		}
	}
	s.poc = true
	requireStatus(t, get("worktree", "modified.svg"), 404)
	w = api(t, s, "GET", "diff?base=main", nil)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), `"image":`) {
		t.Fatal("PoC image scope changed")
	}
}

func TestImageSourceSnapshotAndOversizedGitBlob(t *testing.T) {
	r := imageFixture(t)
	ctx := context.Background()
	source, err := r.imageSource(ctx, "worktree", "modified.svg")
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, r.Path, "modified.svg", "later bytes")
	data, err := source.read(ctx)
	if err != nil || string(data) != "<svg>working</svg>" {
		t.Fatal("source did not retain captured bytes")
	}
	writeFixture(t, r.Path, "large.png", strings.Repeat("\x00", maxTextBytes+1))
	gitFixture(t, r.Path, "add", "large.png")
	gitFixture(t, r.Path, "commit", "-qm", "large image")
	ref := gitFixture(t, r.Path, "rev-parse", "HEAD")
	if _, err := r.imageSource(ctx, ref, "large.png"); err == nil || !strings.Contains(err.Error(), "20 MB") {
		t.Fatalf("oversized Git blob accepted: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := source.read(cancelled); err != context.Canceled {
		t.Fatalf("cancellation lost: %v", err)
	}
}
