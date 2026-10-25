package app

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
)

func TestRepositoryCommentLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	store := storeFor(repo)
	comments := repositoryComments{store: store}
	review := compare(t, repo, false)
	draft := Comment{ID: "remark", Path: "context.txt", Side: "additions", Start: 90, End: 91, Range: review.Range, Body: "original"}
	created, err := comments.create(ctx, review, draft)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(created.Comment.Anchor, []string{"line 90", "line 91"}) || created.Comment.CreatedAt == "" || created.Comment.Stale {
		t.Fatalf("creation did not capture original lines: %+v", created)
	}

	writeFixture(t, repo.Path, draft.Path, "changed\n")
	current := compare(t, repo, false)
	// Retry after a lost response, with different coordinates and provenance.
	// Existing identity wins even when the incoming lines cannot be read.
	draft.Path, draft.Range, draft.Side = "missing.txt", "another..comparison", "deletions"
	draft.Start, draft.End, draft.Body = 1000, 1001, "retry text"
	draft.Anchor, draft.CreatedAt = []string{"client anchor"}, "client time"
	retried, err := comments.create(ctx, current, draft)
	if err != nil {
		t.Fatal(err)
	}
	want := created.Comment.Comment
	want.Body = draft.Body
	if !reflect.DeepEqual(retried.Comment.Comment, want) || len(retried.Comments) != 1 || !retried.Comment.Stale {
		t.Fatalf("retry changed the first creation or hid stale code: %+v", retried)
	}

	// Restart and edit outside the current comparison without re-anchoring.
	outside, err := repo.Compare(ctx, "HEAD", true)
	if err != nil {
		t.Fatal(err)
	}
	restarted := repositoryComments{store: storeFor(repo)}
	edited, err := restarted.edit(ctx, outside, draft.ID, "  edited outside  ")
	if err != nil {
		t.Fatal(err)
	}
	want.Body = "edited outside"
	if !reflect.DeepEqual(edited.Comment, want) || len(edited.Code) != 0 || edited.Stale {
		t.Fatalf("edit replaced provenance or unavailable code: %+v", edited)
	}
	// POST retries also work without the file in the current comparison.
	retried, err = restarted.create(ctx, outside, draft)
	if err != nil || !reflect.DeepEqual(retried.Comment.Anchor, created.Comment.Anchor) {
		t.Fatalf("outside retry lost its anchor: %+v %v", retried, err)
	}

	hash := "viewed"
	_, err = store.Mutate(ctx, func(state *StoredState) error {
		state.Viewed[review.Range] = ViewedMap{"context.txt": &hash}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	other := Comment{ID: "other", Path: "added.txt", Side: "additions", Start: 1, End: 1, Range: current.Range, Body: "keep"}
	if _, err := comments.create(ctx, current, other); err != nil {
		t.Fatal(err)
	}
	remaining, err := restarted.remove(ctx, draft.ID)
	if err != nil || len(remaining) != 1 || remaining[0].ID != "other" {
		t.Fatalf("delete changed another comment: %+v %v", remaining, err)
	}
	if _, err := restarted.remove(ctx, draft.ID); err != nil {
		t.Fatalf("repeated deletion failed: %v", err)
	}
	state, _, err := store.Snapshot()
	if err != nil || len(state.Viewed[review.Range]) != 1 {
		t.Fatalf("comment deletion affected Viewed: %+v %v", state, err)
	}
}

func TestRepositoryCommentValidation(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	comments := repositoryComments{store: storeFor(repo)}
	review := compare(t, repo, false)
	for _, draft := range []Comment{
		{ID: "invalid", Path: "../outside", Side: "additions", Start: 1, End: 1, Range: "range"},
		{ID: "unavailable", Path: "context.txt", Side: "additions", Start: 1000, End: 1001, Range: "range"},
	} {
		_, err := comments.create(ctx, review, draft)
		var invalid invalidComment
		if !errors.As(err, &invalid) {
			t.Fatalf("invalid creation did not report an input error: %v", err)
		}
	}
	if _, err := comments.edit(ctx, review, "missing", "text"); !errors.Is(err, errCommentMissing) {
		t.Fatalf("missing edit: %v", err)
	}
	if _, err := comments.edit(ctx, review, "missing", "  "); err == nil {
		t.Fatal("empty edit accepted")
	}
	if _, err := comments.remove(ctx, ""); err == nil {
		t.Fatal("empty deletion accepted")
	}
	state, _, err := comments.store.Snapshot()
	if err != nil || len(state.Comments) != 0 {
		t.Fatalf("rejected operations changed persisted comments: %+v %v", state, err)
	}
}

func TestConcurrentCommentCreationKeepsFirstProvenance(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	const writers = 4
	reviews := make([]*Review, writers)
	for i := range reviews {
		reviews[i] = compare(t, repo, false)
	}
	var wg sync.WaitGroup
	results := make(chan ServedComment, writers)
	for i := range writers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			comments := repositoryComments{store: storeFor(repo)}
			draft := Comment{ID: "same", Path: "context.txt", Side: "additions", Start: 90 + i, End: 90 + i, Range: fmt.Sprint(i), Body: fmt.Sprint(i)}
			created, err := comments.create(ctx, reviews[i], draft)
			if err != nil {
				t.Error(err)
				return
			}
			results <- created.Comment
		}(i)
	}
	wg.Wait()
	close(results)
	var first *Comment
	for result := range results {
		result.Body = ""
		if first == nil {
			first = &result.Comment
		} else if !reflect.DeepEqual(*first, result.Comment) {
			t.Fatalf("concurrent retry replaced provenance: %+v != %+v", *first, result.Comment)
		}
	}
	state, _, err := storeFor(repo).Snapshot()
	if err != nil || len(state.Comments) != 1 || first == nil {
		t.Fatalf("concurrent creation duplicated or lost the comment: %+v %v", state, err)
	}
}

func TestCommentResolution(t *testing.T) {
	ctx := context.Background()
	repo := fixture(t)
	comments := repositoryComments{store: storeFor(repo)}
	review := compare(t, repo, false)
	for _, draft := range []Comment{
		{ID: "a1b2c3d4-one", Path: "context.txt", Side: "additions", Start: 80, End: 80, Range: review.Range, Body: "rename"},
		{ID: "a1b2ffff-two", Path: "added.txt", Side: "additions", Start: 1, End: 1, Range: review.Range, Body: "test"},
	} {
		created, err := comments.create(ctx, review, draft)
		if err != nil || created.Comment.Status != statusOpen {
			t.Fatalf("a new comment is not open: %+v %v", created, err)
		}
	}
	var invalid invalidComment
	if _, err := comments.setStatus(ctx, "a1b2", statusResolved); !errors.As(err, &invalid) {
		t.Fatalf("ambiguous prefix: %v", err)
	}
	if _, err := comments.setStatus(ctx, "a1b", statusResolved); !errors.Is(err, errCommentMissing) {
		t.Fatalf("prefix under four characters: %v", err)
	}
	if saved, err := comments.setStatus(ctx, "a1b2c3", statusResolved); err != nil || saved.Status != statusResolved || saved.Body != "rename" {
		t.Fatalf("resolve: %+v %v", saved, err)
	}
	if saved, err := comments.setStatus(ctx, "a1b2c3d4-one", statusOpen); err != nil || saved.Status != statusOpen {
		t.Fatalf("reopen: %+v %v", saved, err)
	}
}
