package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommentTurns(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	comments := repositoryComments{store: storeFor(repo)}
	review := compare(t, repo, false)
	for _, draft := range []Comment{
		{ID: "a1b2c3d4-one", Path: "context.txt", Side: "additions", Start: 80, End: 80, Range: review.Range, Body: "rename"},
		{ID: "a1b2ffff-two", Path: "added.txt", Side: "additions", Start: 1, End: 1, Range: review.Range, Body: "test"},
	} {
		if _, err := comments.create(ctx, review, draft); err != nil {
			t.Fatal(err)
		}
	}
	var invalid invalidComment
	if _, _, err := comments.discuss(ctx, "reply", "a1b2", "done", ""); !errors.As(err, &invalid) {
		t.Fatalf("ambiguous prefix: %v", err)
	}
	if _, _, err := comments.discuss(ctx, "reply", "a1b", "done", ""); !errors.Is(err, errCommentMissing) {
		t.Fatalf("prefix under four characters: %v", err)
	}
	if _, _, err := comments.discuss(ctx, "reply", "a1b2c3", "  ", ""); err == nil {
		t.Fatal("empty reply accepted")
	}

	saved, open, err := comments.discuss(ctx, "reply", "a1b2c3", " Renamed. ", "claude-code")
	if err != nil || saved.Status != statusAnswered || open != 1 || len(saved.Replies) != 1 || saved.Replies[0].Author != authorAgent || saved.Replies[0].Harness != "claude-code" || saved.Replies[0].Body != "Renamed." {
		t.Fatalf("reply: %+v %d %v", saved, open, err)
	}
	if saved, _, err = comments.discuss(ctx, "resolve", "a1b2c3", "", ""); err != nil || saved.Status != statusResolved {
		t.Fatalf("resolve: %+v %v", saved, err)
	}
	if _, _, err := comments.discuss(ctx, "reply", "a1b2c3", "again", ""); !errors.As(err, &invalid) {
		t.Fatalf("reply to a resolved comment: %v", err)
	}
	saved, open, err = comments.discuss(ctx, "reopen", "a1b2c3d4-one", "Not quite", "")
	if err != nil || saved.Status != statusOpen || open != 2 || len(saved.Replies) != 2 || saved.Replies[1].Author != authorReviewer {
		t.Fatalf("reopen: %+v %d %v", saved, open, err)
	}
	if saved, _, err = comments.discuss(ctx, "reopen", "a1b2c3", "", ""); err != nil || len(saved.Replies) != 2 {
		t.Fatalf("reopen without a message added a reply: %+v %v", saved, err)
	}
}

func TestCheckQuotesOnlyWhatTheFileLacks(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	comments := repositoryComments{store: storeFor(repo)}
	review := compare(t, repo, false)
	for _, draft := range []Comment{
		{ID: "11111111-answered", Path: "added.txt", Side: "additions", Start: 1, End: 1, Body: "Test this"},
		{ID: "22222222-stale", Path: "context.txt", Side: "additions", Start: 80, End: 80, Body: "Name it"},
		{ID: "33333333-removed", Path: "deleted.txt", Side: "deletions", Start: 1, End: 1, Body: "Why delete?"},
		{ID: "44444444-reopened", Path: "context.txt", Side: "additions", Start: 10, End: 11, Body: "Simplify"},
	} {
		draft.Range = review.Range
		if _, err := comments.create(ctx, review, draft); err != nil {
			t.Fatal(err)
		}
	}
	for _, turn := range [][3]string{{"reply", "1111", "Added"}, {"reply", "4444", "Done"}, {"reopen", "4444", "Still long"}} {
		if _, _, err := comments.discuss(ctx, turn[0], turn[1], turn[2], ""); err != nil {
			t.Fatal(err)
		}
	}
	current, err := os.ReadFile(filepath.Join(repo.Path, "context.txt"))
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, repo.Path, "context.txt", strings.Replace(string(current), "working 80\n", "fixed 80\n", 1))

	var out, stderr bytes.Buffer
	open, err := CheckComments(ctx, repo.Path, Selection{Base: "main"}, false, false, &out, &stderr)
	_, rest, _ := strings.Cut(out.String(), "\n")
	want := `
44444444 context.txt:10-11
Simplify
reviewer: Still long

22222222 context.txt:80
Name it
was:
  working 80

33333333 deleted.txt:1 (removed lines)
Why delete?
code:
  delete

Reply to each when done: ghl comments reply <id> "<what you did>"
`
	if err != nil || open != 3 || !strings.HasPrefix(out.String(), "3 open on ") || rest != want {
		t.Fatalf("check: %d %v\n%s", open, err, out.String())
	}
	out.Reset()
	if _, err := CheckComments(ctx, repo.Path, Selection{Base: "main"}, false, true, &out, &stderr); err != nil || !strings.Contains(out.String(), "Simplify\nreviewer: Still long\ncode:\n  committed 10\n  line 11\n") {
		t.Fatalf("check --code: %v\n%s", err, out.String())
	}
}
