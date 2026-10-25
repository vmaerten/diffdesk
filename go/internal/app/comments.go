package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

var errCommentMissing = errors.New("Comment no longer exists")

// A comment's status says whose turn it is: the code's author while open, the
// reviewer once answered, nobody once resolved.
const (
	statusOpen     = "open"
	statusAnswered = "answered"
	statusResolved = "resolved"
	authorAgent    = "agent"
	authorReviewer = "reviewer"
)

func validThread(c Comment) bool {
	if c.Status != statusOpen && c.Status != statusAnswered && c.Status != statusResolved {
		return false
	}
	for _, reply := range c.Replies {
		if (reply.Author != authorAgent && reply.Author != authorReviewer) || reply.Body == "" || reply.CreatedAt == "" {
			return false
		}
	}
	return true
}

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
	if draft.ID == "" || !validPath(draft.Path) || draft.Range == "" || !validLocation(draft) {
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
		draft.CreatedAt = now()
		draft.Status, draft.Replies = statusOpen, nil
		state.Comments = append(state.Comments, draft)
		saved = draft
		return nil
	})
	if err != nil {
		return commentCreation{}, err
	}
	return commentCreation{Comment: review.Comments(ctx, []Comment{saved})[0], Comments: state.Comments}, nil
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

// Older comments only recorded a comparison. Its target recovers their branch
// without rewriting provenance or assigning them to whichever branch opens first.
func commentBranch(comment Comment) string {
	if comment.Branch != "" {
		return comment.Branch
	}
	_, branch, _ := strings.Cut(comment.Range, "..")
	return strings.TrimPrefix(branch, "refs/heads/")
}

func (r *Review) branchComments(stored []Comment) []Comment {
	comments := make([]Comment, 0, len(stored))
	for _, comment := range stored {
		if commentBranch(comment) == r.CommentBranch {
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

// discuss takes a turn on a comment: the agent replies, which hands it to the
// reviewer, or the reviewer resolves or reopens it. It reports how many
// comments on the same branch are left open.
func (c repositoryComments) discuss(ctx context.Context, verb, id, body string) (Comment, int, error) {
	body = strings.TrimSpace(body)
	if verb == "reply" && body == "" {
		return Comment{}, 0, invalidComment("A reply needs a message")
	}
	var saved Comment
	state, err := c.store.Mutate(ctx, func(state *StoredState) error {
		i, err := findComment(state.Comments, id)
		if err != nil {
			return err
		}
		comment := &state.Comments[i]
		switch verb {
		case "reply":
			if comment.Status == statusResolved {
				return invalidComment("The reviewer resolved this comment")
			}
			comment.Status = statusAnswered
			comment.Replies = append(comment.Replies, Reply{Author: authorAgent, Body: body, CreatedAt: now()})
		case "resolve":
			comment.Status = statusResolved
		case "reopen":
			comment.Status = statusOpen
			if body != "" {
				comment.Replies = append(comment.Replies, Reply{Author: authorReviewer, Body: body, CreatedAt: now()})
			}
		default:
			return invalidComment(fmt.Sprintf("Unknown comment action %q", verb))
		}
		saved = *comment
		return nil
	})
	if err != nil {
		return Comment{}, 0, err
	}
	open := 0
	for _, comment := range state.Comments {
		if comment.Status == statusOpen && commentBranch(comment) == commentBranch(saved) {
			open++
		}
	}
	return saved, open, nil
}
