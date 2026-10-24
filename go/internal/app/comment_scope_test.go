package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestAPICommentsDoNotLeakToAnotherBranchAfterRestart(t *testing.T) {
	s := testServer(t)
	gitFixture(t, s.repo.Path, "branch", "other", "feature")
	review := compare(t, s.repo, false)
	comment := Comment{ID: "feature-comment", Path: "context.txt", Side: "additions", Start: 10, End: 10, Range: review.Range, Body: "Only for feature"}
	requireStatus(t, api(t, s, "POST", "comments?target=feature", comment), 200)

	// Restart with a fresh server and Store reading the same persisted state.
	restarted := &Server{repo: s.repo, id: s.id, store: &Store{path: s.store.path}}
	for _, branch := range []string{"feature", "other", "feature"} {
		w := api(t, restarted, "GET", "diff?target="+branch, nil)
		requireStatus(t, w, 200)
		var payload struct {
			Comments []ServedComment `json:"comments"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		want := 0
		if branch == "feature" {
			want = 1
		}
		if len(payload.Comments) != want {
			t.Errorf("branch %s after restart: got %d comments, want %d: %+v", branch, len(payload.Comments), want, payload.Comments)
		}
	}
}

func TestBranchCommentsSurviveComparisonChangesAndCheckout(t *testing.T) {
	ctx := context.Background()
	s := testServer(t)
	gitFixture(t, s.repo.Path, "branch", "other", "feature")
	comment := Comment{ID: "commit-comment", Path: "context.txt", Side: "additions", Start: 10, End: 10, Range: "feature^..feature", Body: "On a selected commit"}
	requireStatus(t, api(t, s, "POST", "comments?target=feature&commit=feature", comment), 200)
	_, err := s.store.Mutate(ctx, func(state *StoredState) error {
		state.Comments = append(state.Comments, Comment{ID: "legacy", Path: "missing.txt", Side: "additions", Start: 1, End: 1, Range: "old-base..feature", Body: "Legacy comment outside the diff", Anchor: []string{"original"}, CreatedAt: "2020-01-01T00:00:00Z"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	assertComments := func(route, branch string, want int) {
		t.Helper()
		w := api(t, s, "GET", route, nil)
		requireStatus(t, w, 200)
		var payload struct {
			CommentBranch string          `json:"commentBranch"`
			Comments      []ServedComment `json:"comments"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.CommentBranch != branch || len(payload.Comments) != want {
			t.Fatalf("%s: got branch %q and comments %+v, want branch %q and %d comments", route, payload.CommentBranch, payload.Comments, branch, want)
		}
	}
	for _, query := range []string{"", "?target=feature", "?target=refs/heads/feature", "?target=HEAD", "?base=HEAD", "?commit=feature", "?committed", "?w=1"} {
		assertComments("diff"+query, "feature", 2)
	}
	assertComments("diff?target=other&commit=feature", "other", 0)

	// The CLI must apply the same branch filter, even for identical file changes.
	for _, branch := range []string{"feature", "other"} {
		review, err := s.repo.Resolve(ctx, Selection{Base: "main", Target: branch})
		if err != nil {
			t.Fatal(err)
		}
		var output, notices bytes.Buffer
		if err := writeComments(ctx, review, s.store, true, &output, &notices); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(output.String(), "commit-comment") != (branch == "feature") || strings.Contains(output.String(), "legacy") {
			t.Fatalf("wrong CLI selection for %s: %s", branch, output.String())
		}
	}

	gitFixture(t, s.repo.Path, "stash", "push", "-qu")
	gitFixture(t, s.repo.Path, "checkout", "-q", "other")
	s.store = &Store{path: s.store.path}
	assertComments("diff", "other", 0)
	gitFixture(t, s.repo.Path, "checkout", "-q", "feature")
	assertComments("diff", "feature", 2)
	state, _, err := s.store.Snapshot()
	if err != nil || len(state.Comments) != 2 || state.Comments[0].Branch != "feature" || state.Comments[1].Range != "old-base..feature" {
		t.Fatalf("branch switching changed stored comments: %+v %v", state, err)
	}
}
