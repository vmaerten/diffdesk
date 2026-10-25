package app

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// CheckComments prints the branch's open comments for an agent and reports how
// many there are. Unlike the export it keeps comments on files that left the
// comparison: reverting a file does not answer the remark made on it.
func CheckComments(ctx context.Context, repoPath string, selection Selection, jsonOutput, withCode bool, stdout, stderr io.Writer) (int, error) {
	review, store, err := openReview(ctx, repoPath, selection)
	if err != nil {
		return 0, err
	}
	state, err := snapshot(review, store, stderr)
	if err != nil {
		return 0, err
	}
	open := make([]Comment, 0, len(state.Comments))
	for _, comment := range review.branchComments(state.Comments) {
		if comment.Status == statusOpen {
			open = append(open, comment)
		}
	}
	comments := review.Comments(ctx, open)
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if jsonOutput {
		return len(comments), writeCommentExport(comments, review.repo.Path, review.Range, true, stdout)
	}
	return len(comments), writeOpenComments(comments, review.Range, withCode, stdout)
}

// writeOpenComments leaves out what an agent reads in the file anyway, since
// every line costs it tokens: only lines the file no longer has are quoted.
func writeOpenComments(comments []ServedComment, comparison string, withCode bool, out io.Writer) error {
	if len(comments) == 0 {
		_, err := fmt.Fprintf(out, "No open comments on %s.\n", comparison)
		return err
	}
	var text strings.Builder
	fmt.Fprintf(&text, "%d open on %s\n", len(comments), comparison)
	lines := func(label string, lines []string) {
		fmt.Fprintf(&text, "%s:\n", label)
		for _, line := range lines {
			fmt.Fprintf(&text, "  %s\n", line)
		}
	}
	for _, c := range readingOrder(comments) {
		location := fmt.Sprintf("%s:%d", c.Path, c.Start)
		if c.End != c.Start {
			location += fmt.Sprintf("-%d", c.End)
		}
		if c.Side == "deletions" {
			location += " (removed lines)"
		}
		fmt.Fprintf(&text, "\n%s %s\n%s\n", shortID(c.ID), location, c.Body)
		if n := len(c.Replies); n > 0 && c.Replies[n-1].Author == authorReviewer {
			fmt.Fprintf(&text, "reviewer: %s\n", c.Replies[n-1].Body)
		}
		if len(c.Code) > 0 && (withCode || c.Side == "deletions") {
			lines("code", c.Code)
		}
		if len(c.Anchor) > 0 && (c.Stale || len(c.Code) == 0) {
			lines("was", c.Anchor)
		}
	}
	text.WriteString("\nReply to each when done: ghl comments reply <id> \"<what you did>\"\n")
	_, err := io.WriteString(out, text.String())
	return err
}

// The first group of a UUID: findComment takes any unique prefix back.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// DiscussComment takes a turn on the comment whose ID starts with id: verb is
// reply for the agent, resolve or reopen for the reviewer.
func DiscussComment(ctx context.Context, repoPath, verb, id, message string, stdout io.Writer) error {
	repo, err := openRepository(ctx, repoPath)
	if err != nil {
		return err
	}
	_, open, err := (repositoryComments{store: storeFor(repo)}).discuss(ctx, verb, id, message)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "ok, %d open left\n", open)
	return err
}
