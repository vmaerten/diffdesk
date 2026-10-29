package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

var errCommentMissing = errors.New("Comment no longer exists")

// A resolved comment is closed but kept, unlike a deleted one.
const (
	statusOpen     = "open"
	statusResolved = "resolved"
)

type invalidComment string

func (e invalidComment) Error() string { return string(e) }

// repositoryComments owns comment identity, original anchors and persistence.
// Review supplies current code; Store owns cross-process locking and disk writes.
type repositoryComments struct{ store *Store }

type commentCreation struct {
	Comment  ServedComment `json:"comment"`
	Comments []Comment     `json:"comments"`
}

func (c repositoryComments) create(ctx context.Context, review *Review, draft Comment) (commentCreation, error) {
	if draft.ID == "" || !validTarget(draft) || draft.Range == "" || !validLocation(draft) {
		return commentCreation{}, invalidComment("A comment ID, path, range and valid line location are required")
	}
	var saved Comment
	state, err := c.store.Mutate(ctx, func(state *StoredState) error {
		for i := range state.Comments {
			if state.Comments[i].ID == draft.ID {
				// A lost response can cause POST to be retried after code moved.
				// Only text changes; the first successful creation owns provenance.
				state.Comments[i].Body = draft.Body
				saved = state.Comments[i]
				return nil
			}
		}
		anchor, err := review.Lines(ctx, draft)
		if err != nil {
			return invalidComment(err.Error())
		}
		draft.Anchor = anchor
		draft.Branch = review.CommentBranch
		draft.CreatedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		draft.Status = statusOpen
		state.Comments = append(state.Comments, draft)
		saved = draft
		return nil
	})
	if err != nil {
		return commentCreation{}, err
	}
	return commentCreation{Comment: review.Comments(ctx, []Comment{saved})[0], Comments: state.Comments}, nil
}

// Older comments only recorded a comparison. Its target recovers their branch
// without rewriting provenance or assigning them to whichever branch opens first.
func (r *Review) branchComments(stored []Comment) []Comment {
	comments := make([]Comment, 0, len(stored))
	for _, comment := range stored {
		branch := comment.Branch
		if branch == "" {
			_, branch, _ = strings.Cut(comment.Range, "..")
			branch = strings.TrimPrefix(branch, "refs/heads/")
		}
		if branch == r.CommentBranch {
			comments = append(comments, comment)
		}
	}
	return comments
}

func (c repositoryComments) edit(ctx context.Context, review *Review, id, body string) (ServedComment, error) {
	body = strings.TrimSpace(body)
	if id == "" || body == "" {
		return ServedComment{}, invalidComment("A comment ID and non-empty body are required")
	}
	var saved Comment
	_, err := c.store.Mutate(ctx, func(state *StoredState) error {
		for i := range state.Comments {
			if state.Comments[i].ID == id {
				state.Comments[i].Body = body
				saved = state.Comments[i]
				return nil
			}
		}
		return errCommentMissing
	})
	if err != nil {
		return ServedComment{}, err
	}
	return review.Comments(ctx, []Comment{saved})[0], nil
}

func (c repositoryComments) remove(ctx context.Context, id string) ([]Comment, error) {
	if id == "" {
		return nil, invalidComment("missing id")
	}
	state, err := c.store.Mutate(ctx, func(state *StoredState) error {
		kept := make([]Comment, 0, len(state.Comments))
		for _, comment := range state.Comments {
			if comment.ID != id {
				kept = append(kept, comment)
			}
		}
		state.Comments = kept
		return nil
	})
	return state.Comments, err
}

// findComment accepts a whole ID or, as Git does for commits, a unique prefix
// of at least four characters: the terminal shows IDs shortened.
func findComment(comments []Comment, id string) (int, error) {
	found := -1
	for i, comment := range comments {
		if comment.ID == id {
			return i, nil
		}
		if len(id) >= 4 && strings.HasPrefix(comment.ID, id) {
			if found >= 0 {
				return -1, invalidComment(fmt.Sprintf("Comment ID %s is ambiguous; give more characters", id))
			}
			found = i
		}
	}
	if found < 0 {
		return -1, errCommentMissing
	}
	return found, nil
}

// setStatus resolves or reopens the comment whose ID starts with id.
func (c repositoryComments) setStatus(ctx context.Context, id, status string) (Comment, error) {
	if status != statusOpen && status != statusResolved {
		return Comment{}, invalidComment(fmt.Sprintf("Unknown comment status %q", status))
	}
	var saved Comment
	_, err := c.store.Mutate(ctx, func(state *StoredState) error {
		i, err := findComment(state.Comments, id)
		if err != nil {
			return err
		}
		state.Comments[i].Status = status
		saved = state.Comments[i]
		return nil
	})
	return saved, err
}
