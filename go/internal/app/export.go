package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
	"unicode/utf16"
)

type exportedComment struct {
	ID     string    `json:"id"`
	Path   string    `json:"path"`
	Side   string    `json:"side"`
	Start  int       `json:"start"`
	End    int       `json:"end"`
	Body   string    `json:"body"`
	Code   []string  `json:"code"`
	Was    *[]string `json:"was,omitempty"`
	Status string    `json:"status"`
}

// Use the same locale-independent UTF-16 path order as src/export.ts. A stable
// sort preserves write order for comments at the same path and starting line.
func readingOrder(comments []ServedComment) []ServedComment {
	ordered := slices.Clone(comments)
	slices.SortStableFunc(ordered, func(a, b ServedComment) int {
		if a.Path != b.Path {
			return slices.Compare(utf16.Encode([]rune(a.Path)), utf16.Encode([]rune(b.Path)))
		}
		return a.Start - b.Start
	})
	return ordered
}

// ExportOptions selects what ExportComments writes.
type ExportOptions struct {
	// All includes resolved comments.
	All  bool
	JSON bool
	// Code quotes the current lines of every comment, not only the lines its
	// file no longer has.
	Code bool
}

func writeCommentExport(comments []ServedComment, repo, comparison string, options ExportOptions, out io.Writer) error {
	ordered := readingOrder(comments)
	if options.JSON {
		entries := make([]exportedComment, 0, len(ordered))
		for _, c := range ordered {
			entry := exportedComment{ID: c.ID, Path: c.Path, Side: c.Side, Start: c.Start, End: c.End, Body: c.Body, Code: c.Code, Status: c.Status}
			if c.Stale {
				entry.Was = &c.Anchor
			}
			entries = append(entries, entry)
		}
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		encoder.SetEscapeHTML(false)
		return encoder.Encode(struct {
			Repo     string            `json:"repo"`
			Range    string            `json:"range"`
			Comments []exportedComment `json:"comments"`
		}{repo, comparison, entries})
	}
	return writeCommentText(ordered, comparison, options.Code, out)
}

// writeCommentText is what an agent is handed, by `diffdesk comments` and by Copy
// alike: every line costs it tokens, so a comment quotes only the lines its file
// no longer has, removed or changed since. src/export.ts writes the same text.
func writeCommentText(ordered []ServedComment, comparison string, withCode bool, out io.Writer) error {
	if len(ordered) == 0 {
		_, err := fmt.Fprintf(out, "No comments on %s.\n", comparison)
		return err
	}
	plural := ""
	if len(ordered) > 1 {
		plural = "s"
	}
	var text strings.Builder
	fmt.Fprintf(&text, "%d comment%s on %s\n", len(ordered), plural, comparison)
	block := func(label string, lines []string) {
		fmt.Fprintf(&text, "%s:\n", label)
		for _, line := range lines {
			fmt.Fprintf(&text, "  %s\n", line)
		}
	}
	for _, c := range ordered {
		// The ID is what `diffdesk comments resolve` and `reopen` take back.
		location := fmt.Sprintf("%s %s:%d", shortID(c.ID), c.Path, c.Start)
		if c.End != c.Start {
			location += fmt.Sprintf("-%d", c.End)
		}
		if c.Side == "deletions" {
			location += " (removed lines)"
		}
		if c.Status != "" && c.Status != statusOpen {
			location += " · " + c.Status
		}
		fmt.Fprintf(&text, "\n%s\n%s\n", location, c.Body)
		if len(c.Code) > 0 && (withCode || c.Side == "deletions") {
			block("code", c.Code)
		}
		if (c.Stale || len(c.Code) == 0) && len(c.Anchor) > 0 {
			block("was", c.Anchor)
		}
	}
	_, err := io.WriteString(out, text.String())
	return err
}

// ExportComments writes the branch's comments on the files of a comparison, as
// text or JSON. Untracked files count as part of it.
func ExportComments(ctx context.Context, repoPath string, selection Selection, options ExportOptions, stdout, stderr io.Writer) error {
	repo, err := openRepository(ctx, repoPath)
	if err != nil {
		return err
	}
	selection.IncludeUntracked = true
	review, err := repo.Resolve(ctx, selection)
	if err != nil {
		return err
	}
	return writeComments(ctx, review, storeFor(repo), options, stdout, stderr)
}

func writeComments(ctx context.Context, review *Review, store *Store, options ExportOptions, stdout, stderr io.Writer) error {
	state, notice, err := store.Snapshot()
	if err != nil {
		return err
	}
	for _, notice := range []*string{notice, review.Notice} {
		if notice == nil {
			continue
		}
		if _, err := fmt.Fprintln(stderr, "diffdesk:", *notice); err != nil {
			return err
		}
	}
	// Keep the branch's comments on files in this comparison, even if the base
	// changed since creation. The UI also retains this branch's outside comments.
	paths := make(map[string]bool, len(review.Files))
	for _, file := range review.Files {
		paths[file.Path] = true
	}
	selected := make([]Comment, 0, len(state.Comments))
	for _, comment := range review.branchComments(state.Comments) {
		if paths[comment.Path] && (options.All || comment.Status != statusResolved) {
			selected = append(selected, comment)
		}
	}
	comments := review.Comments(ctx, selected)
	if err := ctx.Err(); err != nil {
		return err
	}
	return writeCommentExport(comments, review.repo.Path, review.Range, options, stdout)
}

// The first group of a UUID: findComment takes any unique prefix back.
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// SetCommentStatus resolves or reopens, from the terminal, the comment whose ID
// starts with id.
func SetCommentStatus(ctx context.Context, repoPath, id, status string, stdout io.Writer) error {
	repo, err := openRepository(ctx, repoPath)
	if err != nil {
		return err
	}
	saved, err := (repositoryComments{store: storeFor(repo)}).setStatus(ctx, id, status)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s %s\n", shortID(saved.ID), saved.Status)
	return err
}
