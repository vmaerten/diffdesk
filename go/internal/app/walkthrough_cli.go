package app

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

//go:embed walkthrough_guide.md
var walkthroughGuide string

// WalkthroughGuide writes the rules an agent follows to write a walkthrough.
func WalkthroughGuide(stdout io.Writer) error {
	_, err := io.WriteString(stdout, walkthroughGuide)
	return err
}

// walkthroughReview resolves the comparison the walkthrough commands work on:
// the one `diffdesk comments` exports, untracked files included.
func walkthroughReview(ctx context.Context, repoPath string, selection Selection) (*Review, error) {
	repo, err := openRepository(ctx, repoPath)
	if err != nil {
		return nil, err
	}
	selection.IncludeUntracked = true
	return repo.Resolve(ctx, selection)
}

type exportedHunk struct {
	ID        string   `json:"id"`
	Path      string   `json:"path"`
	Header    string   `json:"header"`
	Additions int      `json:"additions"`
	Deletions int      `json:"deletions"`
	Lines     []string `json:"lines,omitempty"`
}

// WalkthroughHunks lists the comparison's hunk IDs, with their code when code is set.
func WalkthroughHunks(ctx context.Context, repoPath string, selection Selection, jsonOutput, code bool, stdout io.Writer) error {
	review, err := walkthroughReview(ctx, repoPath, selection)
	if err != nil {
		return err
	}
	hunks := review.hunks()
	if jsonOutput {
		entries := make([]exportedHunk, 0, len(hunks))
		for _, h := range hunks {
			entry := exportedHunk{ID: h.ID, Path: h.Path, Header: h.Header, Additions: h.Additions, Deletions: h.Deletions}
			if code {
				entry.Lines = h.Lines
			}
			entries = append(entries, entry)
		}
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		encoder.SetEscapeHTML(false)
		return encoder.Encode(struct {
			Repo  string         `json:"repo"`
			Range string         `json:"range"`
			Hunks []exportedHunk `json:"hunks"`
		}{review.repo.Path, review.Range, entries})
	}
	_, err = io.WriteString(stdout, listHunks(hunks, review.Range, code))
	return err
}

// listHunks is the text `walkthrough hunks` prints, which a generation sends too.
func listHunks(hunks []hunk, rangeName string, code bool) string {
	var text strings.Builder
	files := 0
	for i, h := range hunks {
		if i == 0 || hunks[i-1].Path != h.Path {
			files++
		}
	}
	fmt.Fprintf(&text, "%d hunks in %d files on %s\n", len(hunks), files, rangeName)
	for _, h := range hunks {
		fmt.Fprintf(&text, "%s  +%d -%d  %s\n", h.ID, h.Additions, h.Deletions, h.Header)
		if code {
			for _, line := range h.Lines {
				fmt.Fprintf(&text, "  %s\n", line)
			}
		}
	}
	return text.String()
}

// SetWalkthrough validates a document against the comparison and saves it as
// the reviewed branch's walkthrough, replacing the previous one.
func SetWalkthrough(ctx context.Context, repoPath string, selection Selection, input io.Reader, stdout io.Writer) error {
	w, err := decodeWalkthrough(input)
	if err != nil {
		return err
	}
	review, err := walkthroughReview(ctx, repoPath, selection)
	if err != nil {
		return err
	}
	hunks := review.hunks()
	if problems := w.validate(hunks); len(problems) > 0 {
		return fmt.Errorf("walkthrough not saved:\n  %s", strings.Join(problems, "\n  "))
	}
	stored, err := saveWalkthrough(review, hunks, w, "agent")
	if err != nil {
		return err
	}
	stops := 0
	for _, chapter := range w.Chapters {
		stops += len(chapter.Stops)
	}
	_, err = fmt.Fprintf(stdout, "Walkthrough saved for %s: %d stops, %d of %d hunks.\n", review.CommentBranch, stops, len(stored.Fingerprints), len(hunks))
	return err
}

// saveWalkthrough stores a valid document as the branch's walkthrough, with the
// fingerprints of the hunks it cites.
func saveWalkthrough(review *Review, hunks []hunk, w Walkthrough, author string) (storedWalkthrough, error) {
	fingerprints := map[string]string{}
	for _, h := range hunks {
		fingerprints[h.ID] = h.Fingerprint
	}
	stored := storedWalkthrough{
		Version: 1, Branch: review.CommentBranch, Range: review.Range, WorkingTree: review.Comparison.After == nil,
		Author: author, CreatedAt: time.Now().UTC().Format(time.RFC3339), Fingerprints: map[string]string{}, Walkthrough: w,
	}
	for _, id := range w.cited() {
		stored.Fingerprints[id] = fingerprints[id]
	}
	if err := writeWalkthrough(walkthroughPath(review.repo.GitDir, review.CommentBranch), stored); err != nil {
		return storedWalkthrough{}, err
	}
	return stored, nil
}

// ShowWalkthrough prints the branch's walkthrough against the current diff.
func ShowWalkthrough(ctx context.Context, repoPath string, selection Selection, stdout io.Writer) error {
	review, err := walkthroughReview(ctx, repoPath, selection)
	if err != nil {
		return err
	}
	stored, err := readWalkthrough(walkthroughPath(review.repo.GitDir, review.CommentBranch))
	if err != nil {
		return err
	}
	if stored == nil {
		_, err = fmt.Fprintf(stdout, "No walkthrough for %s.\n", review.CommentBranch)
		return err
	}
	hunks := review.hunks()
	found := stored.locate(hunks)
	w := stored.Walkthrough
	var text strings.Builder
	fmt.Fprintf(&text, "%s\n", w.Title)
	if w.Focus != "" {
		fmt.Fprintf(&text, "%s\n", w.Focus)
	}
	fmt.Fprintf(&text, "Written by %s on %s for %s", stored.Author, strings.SplitN(stored.CreatedAt, "T", 2)[0], stored.Range)
	if stored.WorkingTree {
		text.WriteString(" with the working tree")
	}
	text.WriteString(".\n")
	if stale(found) {
		text.WriteString("Stale: half its hunks or more are gone from this diff; write it again.\n")
	}
	list := func(ids []string) string {
		names := make([]string, len(ids))
		for i, id := range ids {
			if h := found[id]; h != nil {
				names[i] = h.ID
			} else {
				names[i] = id + " (gone)"
			}
		}
		return strings.Join(names, ", ")
	}
	for i, chapter := range w.Chapters {
		fmt.Fprintf(&text, "\n%d. %s\n", i+1, chapter.Title)
		for j, stop := range chapter.Stops {
			fmt.Fprintf(&text, "  %d.%d %s\n    %s\n", i+1, j+1, stop.Title, stop.Summary)
			if stop.Prose != "" {
				fmt.Fprintf(&text, "    %s\n", stop.Prose)
			}
			fmt.Fprintf(&text, "    %s\n", list(stop.Hunks))
		}
	}
	located := map[*hunk]bool{}
	for _, h := range found {
		located[h] = true
	}
	var uncited []string
	for i := range hunks {
		if !located[&hunks[i]] {
			uncited = append(uncited, hunks[i].ID)
		}
	}
	if len(w.Support) > 0 || len(uncited) > 0 {
		text.WriteString("\nSupport\n")
		for _, aside := range w.Support {
			fmt.Fprintf(&text, "  %s: %s\n", aside.Note, list(aside.Hunks))
		}
		if len(uncited) > 0 {
			fmt.Fprintf(&text, "  Not in the walkthrough: %s\n", strings.Join(uncited, ", "))
		}
	}
	_, err = io.WriteString(stdout, text.String())
	return err
}

// ClearWalkthrough deletes the branch's walkthrough.
func ClearWalkthrough(ctx context.Context, repoPath string, selection Selection, stdout io.Writer) error {
	review, err := walkthroughReview(ctx, repoPath, selection)
	if err != nil {
		return err
	}
	err = os.Remove(walkthroughPath(review.repo.GitDir, review.CommentBranch))
	if os.IsNotExist(err) {
		_, err = fmt.Fprintf(stdout, "No walkthrough for %s.\n", review.CommentBranch)
		return err
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "Walkthrough cleared for %s.\n", review.CommentBranch)
	return err
}
