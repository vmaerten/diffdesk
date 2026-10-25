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
	ID      string    `json:"id"`
	Path    string    `json:"path"`
	Side    string    `json:"side"`
	Start   int       `json:"start"`
	End     int       `json:"end"`
	Body    string    `json:"body"`
	Code    []string  `json:"code"`
	Was     *[]string `json:"was,omitempty"`
	Status  string    `json:"status"`
	Replies []Reply   `json:"replies"`
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

func writeCommentExport(comments []ServedComment, repo, comparison string, jsonOutput bool, out io.Writer) error {
	ordered := readingOrder(comments)
	if jsonOutput {
		entries := make([]exportedComment, 0, len(ordered))
		for _, c := range ordered {
			entry := exportedComment{ID: c.ID, Path: c.Path, Side: c.Side, Start: c.Start, End: c.End, Body: c.Body, Code: c.Code, Status: c.Status, Replies: c.Replies}
			if entry.Replies == nil {
				entry.Replies = []Reply{}
			}
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
	if len(ordered) == 0 {
		_, err := fmt.Fprintf(out, "No comments on %s.\n", comparison)
		return err
	}
	plural := ""
	if len(ordered) > 1 {
		plural = "s"
	}
	var text strings.Builder
	fmt.Fprintf(&text, "# %d comment%s on %s\n", len(ordered), plural, comparison)
	file := ""
	for _, c := range ordered {
		if c.Path != file {
			file = c.Path
			fmt.Fprintf(&text, "\n## %s\n", file)
		}
		label := fmt.Sprintf("L%d", c.Start)
		if c.Start != c.End {
			label += fmt.Sprintf("–L%d", c.End)
		}
		// The ID is what reply, resolve and reopen take back.
		label = "**" + label + "** · " + shortID(c.ID)
		if c.Status != "" && c.Status != statusOpen {
			label += " · " + c.Status
		}
		fmt.Fprintf(&text, "\n%s\n", label)
		if len(c.Code) > 0 {
			fmt.Fprintf(&text, "\n```\n%s\n```\n", strings.Join(c.Code, "\n"))
		}
		fmt.Fprintf(&text, "\n%s\n", c.Body)
		for _, reply := range c.Replies {
			fmt.Fprintf(&text, "\n↳ %s: %s\n", reply.Author, reply.Body)
		}
		if (c.Stale || len(c.Code) == 0) && len(c.Anchor) > 0 {
			explanation := "These lines have changed since the remark was written. They read:"
			if len(c.Code) == 0 {
				explanation = "Code is unavailable in the current comparison. Original lines:"
			}
			fmt.Fprintf(&text, "\n> %s\n\n```\n%s\n```\n", explanation, strings.Join(c.Anchor, "\n"))
		}
	}
	_, err := io.WriteString(out, text.String())
	return err
}

// ExportComments writes the branch's comments on the files of a comparison, as
// Markdown or JSON, with their code and replies. Untracked files count as part
// of it. Resolved comments are left out unless all is set.
func ExportComments(ctx context.Context, repoPath string, selection Selection, all, jsonOutput bool, stdout, stderr io.Writer) error {
	review, store, err := openReview(ctx, repoPath, selection)
	if err != nil {
		return err
	}
	return writeComments(ctx, review, store, all, jsonOutput, stdout, stderr)
}

func openReview(ctx context.Context, repoPath string, selection Selection) (*Review, *Store, error) {
	repo, err := openRepository(ctx, repoPath)
	if err != nil {
		return nil, nil, err
	}
	selection.IncludeUntracked = true
	review, err := repo.Resolve(ctx, selection)
	return review, storeFor(repo), err
}

// snapshot reads the state for the terminal, reporting its notices and the
// review's on stderr.
func snapshot(review *Review, store *Store, stderr io.Writer) (StoredState, error) {
	state, notice, err := store.Snapshot()
	if err != nil {
		return state, err
	}
	for _, notice := range []*string{notice, review.Notice} {
		if notice == nil {
			continue
		}
		if _, err := fmt.Fprintln(stderr, "ghl:", *notice); err != nil {
			return state, err
		}
	}
	return state, nil
}

func writeComments(ctx context.Context, review *Review, store *Store, all, jsonOutput bool, stdout, stderr io.Writer) error {
	state, err := snapshot(review, store, stderr)
	if err != nil {
		return err
	}
	// Keep the branch's comments on files in this comparison, even if the base
	// changed since creation. The UI also retains this branch's outside comments.
	paths := make(map[string]bool, len(review.Files))
	for _, file := range review.Files {
		paths[file.Path] = true
	}
	selected := make([]Comment, 0, len(state.Comments))
	for _, comment := range review.branchComments(state.Comments) {
		if paths[comment.Path] && (all || comment.Status != statusResolved) {
			selected = append(selected, comment)
		}
	}
	comments := review.Comments(ctx, selected)
	if err := ctx.Err(); err != nil {
		return err
	}
	return writeCommentExport(comments, review.repo.Path, review.Range, jsonOutput, stdout)
}
