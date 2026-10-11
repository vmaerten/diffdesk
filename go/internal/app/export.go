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
	ID    string    `json:"id"`
	Path  string    `json:"path"`
	Side  string    `json:"side"`
	Start int       `json:"start"`
	End   int       `json:"end"`
	Body  string    `json:"body"`
	Code  []string  `json:"code"`
	Was   *[]string `json:"was,omitempty"`
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
			entry := exportedComment{ID: c.ID, Path: c.Path, Side: c.Side, Start: c.Start, End: c.End, Body: c.Body, Code: c.Code}
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
		fmt.Fprintf(&text, "\n**%s**\n", label)
		if len(c.Code) > 0 {
			fmt.Fprintf(&text, "\n```\n%s\n```\n", strings.Join(c.Code, "\n"))
		}
		fmt.Fprintf(&text, "\n%s\n", c.Body)
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

func writeComments(ctx context.Context, review *Review, store *Store, jsonOutput bool, stdout, stderr io.Writer) error {
	state, notice, err := store.Snapshot(ctx)
	if err != nil {
		return err
	}
	if notice != nil {
		if _, err := fmt.Fprintln(stderr, "ghl:", *notice); err != nil {
			return err
		}
	}
	// Like Node's CLI, include comments on files in this comparison regardless
	// of their saved range. The UI separately retains comments outside it.
	paths := make(map[string]bool, len(review.Files))
	for _, file := range review.Files {
		paths[file.Path] = true
	}
	selected := make([]Comment, 0, len(state.Comments))
	for _, comment := range state.Comments {
		if paths[comment.Path] {
			selected = append(selected, comment)
		}
	}
	comments := review.Comments(ctx, selected)
	if err := ctx.Err(); err != nil {
		return err
	}
	return writeCommentExport(comments, review.repo.Path, review.Range, jsonOutput, stdout)
}

func writeSummary(review *Review, target string, out io.Writer) error {
	source := map[string]string{
		"override": "given on the command line", "remembered": "remembered in .git/config",
		"stack": "what the gh stack chain says this sits on", "trunk": "repository trunk",
	}
	if review.Resolution.Distance != nil {
		source["guessed"] = fmt.Sprintf("guessed (stacked branch, %d commit(s))", *review.Resolution.Distance)
	}
	if target == "" {
		target = review.Target + " + working tree"
	}
	// Match Node's --print: count the patch itself, excluding file headers.
	var files, additions, deletions int
	for _, line := range strings.Split(review.Patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			files++
		case strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++"):
			additions++
		case strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---"):
			deletions++
		}
	}
	var text strings.Builder
	fmt.Fprintf(&text, "repo      %s\nreviewing %s\nbase      %s  — %s\nchanges   %d file(s), +%d -%d\nuntracked %d file(s) (excluded)\n",
		review.repo.Path, target, review.Base, source[review.Resolution.Source], files, additions, deletions, len(review.Untracked))
	if chain := review.Resolution.Stack; chain != nil {
		layers := []string{chain.Trunk}
		for i, layer := range chain.Layers {
			label := layer.Branch
			if layer.PR != nil {
				label += fmt.Sprintf(" #%d", layer.PR.Number)
			}
			if layer.Merged {
				label += " (merged)"
			}
			if i == chain.Current {
				label = "[" + label + "]"
			}
			layers = append(layers, label)
		}
		fmt.Fprintf(&text, "stack     %s\n", strings.Join(layers, " → "))
	}
	_, err := io.WriteString(out, text.String())
	return err
}
