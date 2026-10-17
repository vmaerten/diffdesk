package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

func whitespaceFixture(t *testing.T) Repository {
	t.Helper()
	r := fixture(t)
	gitFixture(t, r.Path, "stash", "push", "-qu")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	var before, after strings.Builder
	for n := 1; n <= 60; n++ {
		fmt.Fprintf(&before, "  const line_%d = %d;\n", n, n)
		if n == 10 {
			after.WriteString("const inserted = true;\n")
		}
		value := n
		if n == 30 {
			value = 999
		}
		fmt.Fprintf(&after, "\tconst line_%d=%d; \t\n", n, value)
	}
	writeFixture(t, r.Path, "mixed.txt", before.String())
	writeFixture(t, r.Path, "format.txt", "const value = 1;\n")
	gitFixture(t, r.Path, "add", ".")
	gitFixture(t, r.Path, "commit", "-qm", "whitespace base")
	gitFixture(t, r.Path, "checkout", "-qb", "whitespace-review")
	writeFixture(t, r.Path, "mixed.txt", after.String())
	writeFixture(t, r.Path, "format.txt", "\tconst value=1;  \n")
	gitFixture(t, r.Path, "add", ".")
	gitFixture(t, r.Path, "commit", "-qm", "format and edit")
	return r
}

func TestIgnoreWhitespaceReviewScopes(t *testing.T) {
	r := whitespaceFixture(t)
	ctx := context.Background()
	for _, selection := range []Selection{
		{Base: "main"},
		{Base: "main", Committed: true},
		{Base: "main", Target: "whitespace-review"},
		{Base: "main", Commit: "HEAD"},
	} {
		full, err := r.Resolve(ctx, selection)
		if err != nil {
			t.Fatal(err)
		}
		selection.IgnoreWhitespace = true
		filtered, err := r.Resolve(ctx, selection)
		if err != nil {
			t.Fatal(err)
		}
		if len(full.Files) != 2 || len(filtered.Files) != 1 || filtered.Files[0].Path != "mixed.txt" || filtered.Totals != (Totals{Files: 1, Additions: 2, Deletions: 1}) {
			t.Fatalf("inconsistent whitespace filtering: full=%+v filtered=%+v totals=%+v", full.Files, filtered.Files, filtered.Totals)
		}
		if filtered.Range != full.Range || filtered.Comparison.Before != full.Comparison.Before {
			t.Fatal("display mode changed comparison provenance")
		}
		args := []string{"diff", "-M", "--no-ext-diff", "--ignore-all-space", filtered.Comparison.Before}
		if filtered.Comparison.After != nil {
			args = append(args, *filtered.Comparison.After)
		}
		args = append(args, "--")
		if want := gitFixture(t, r.Path, args...); strings.TrimSpace(filtered.Patch) != want {
			t.Fatal("filtered patch differs from Git -w")
		}
		f := statFor(t, filtered, "mixed.txt")
		files, err := filtered.Context(ctx, f.Path, *f.Hash)
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(files.OldFile.Contents) != gitFixture(t, r.Path, "show", "main:mixed.txt") || strings.TrimSpace(files.NewFile.Contents) != gitFixture(t, r.Path, "show", "HEAD:mixed.txt") {
			t.Fatal("expanded context did not preserve both source versions")
		}
		// Context in a -w patch uses the new whitespace on both sides. These
		// source lines also have different numbers after the inserted line.
		for _, location := range []struct {
			side string
			line int
			text string
		}{
			{"deletions", 29, "  const line_29 = 29;"},
			{"additions", 30, "\tconst line_29=29; \t"},
			{"additions", 31, "\tconst line_30=999; \t"},
			{"deletions", 55, "  const line_55 = 55;"}, // expanded context
		} {
			lines, err := filtered.Lines(ctx, Comment{Path: f.Path, Side: location.side, Start: location.line, End: location.line})
			if err != nil || len(lines) != 1 || lines[0] != location.text {
				t.Fatalf("wrong %s anchor at %d: %q %v", location.side, location.line, lines, err)
			}
		}
		if *statFor(t, full, f.Path).Hash == *f.Hash {
			t.Fatal("filtered and full context identities collide")
		}
	}
	// Working-tree edits are filtered too; newly created files remain additions.
	writeFixture(t, r.Path, "format.txt", "const value = 1; \t\n")
	writeFixture(t, r.Path, "new.txt", " \tnew file\n")
	review, err := r.Resolve(ctx, Selection{Base: "main", IgnoreWhitespace: true, IncludeUntracked: true})
	if err != nil || len(review.Files) != 2 || !review.UntrackedIncluded {
		t.Fatalf("working tree/untracked: %+v %v", review, err)
	}
	gitFixture(t, r.Path, "checkout", "--", "format.txt")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	writeFixture(t, r.Path, "format.txt", "\tconst value=1;  \n")
	review, err = r.Resolve(ctx, Selection{Base: "main", IgnoreWhitespace: true})
	if err != nil || review.Patch != "" || len(review.Files) != 0 || review.Totals != (Totals{}) {
		t.Fatalf("format-only diff should be empty: %+v %v", review, err)
	}
}

func TestIgnoreWhitespaceAPICommentsAndViewed(t *testing.T) {
	s := testServer(t)
	s.repo = whitespaceFixture(t)
	s.store = Options{}.store(s.repo)
	ctx := context.Background()
	read := func(query string) struct {
		Files    []FileStat
		Patch    string
		Viewed   ViewedMap
		Comments []ServedComment
		Range    string
	} {
		t.Helper()
		w := api(t, s, "GET", "diff?base=main"+query, nil)
		requireStatus(t, w, 200)
		var payload struct {
			Files    []FileStat
			Patch    string
			Viewed   ViewedMap
			Comments []ServedComment
			Range    string
		}
		if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		return payload
	}
	full := read("")
	filtered := read("&w=1")
	if len(read("&w=0").Files) != len(full.Files) || len(filtered.Files) != 1 {
		t.Fatal("URL mode was not respected")
	}
	mark := func(query string, f FileStat, clear bool) {
		t.Helper()
		requireStatus(t, api(t, s, "POST", "viewed"+query, map[string]any{"range": full.Range, "path": f.Path, "hash": f.Hash, "viewed": true, "clear": clear}), 200)
	}
	mark("?w=1", filtered.Files[0], false)
	if len(read("").Viewed) != 0 || len(read("&w=1").Viewed) != 1 {
		t.Fatal("filtered Viewed leaked into the full review")
	}
	mark("", full.Files[1], false)
	if len(read("").Viewed) != 1 || len(read("&w=1").Viewed) != 1 {
		t.Fatal("switching modes lost Viewed state")
	}
	mark("?w=1", filtered.Files[0], true)
	if len(read("").Viewed) != 1 || len(read("&w=1").Viewed) != 0 {
		t.Fatal("resetting filtered Viewed affected the full review")
	}
	for _, c := range []Comment{
		{ID: "old-context", Path: "mixed.txt", Side: "deletions", Start: 29, End: 29, Range: full.Range, Body: "old side"},
		{ID: "new-context", Path: "mixed.txt", Side: "additions", Start: 30, End: 30, Range: full.Range, Body: "new side"},
	} {
		requireStatus(t, api(t, s, "POST", "comments?base=main&w=1", c), 200)
	}
	requireStatus(t, api(t, s, "POST", "comments?base=main", Comment{ID: "hidden", Path: "format.txt", Side: "additions", Start: 1, End: 1, Range: full.Range, Body: "formatting"}), 200)
	comments := read("&w=1").Comments
	if len(comments) != 3 || comments[0].Anchor[0] != "  const line_29 = 29;" || comments[1].Anchor[0] != "\tconst line_29=29; \t" || comments[0].Stale || comments[1].Stale || comments[2].ID != "hidden" {
		t.Fatalf("toggling lost or reattached comments: %+v", comments)
	}
	for _, c := range read("").Comments {
		if c.Stale {
			t.Fatalf("mode changed comment validity: %+v", c)
		}
	}
	f := filtered.Files[0]
	contextQuery := "diff-files?base=main&w=1&path=" + url.QueryEscape(f.Path) + "&hash=" + *f.Hash
	requireStatus(t, api(t, s, "GET", contextQuery, nil), 200)
	requireStatus(t, api(t, s, "GET", strings.Replace(contextQuery, "w=1", "w=0", 1), nil), 409)
	// Restarts keep the independent Viewed scopes and all original comment data.
	s.store = Options{}.store(s.repo)
	state, _, err := s.store.Snapshot(ctx)
	if err != nil || len(state.Comments) != 3 || len(read("").Viewed) != 1 {
		t.Fatal("restart lost state")
	}
}

func TestIgnoreWhitespaceRenameContext(t *testing.T) {
	r := whitespaceFixture(t)
	gitFixture(t, r.Path, "mv", "mixed.txt", "renamed.txt")
	contents := gitFixture(t, r.Path, "show", "HEAD:mixed.txt")
	writeFixture(t, r.Path, "renamed.txt", "  "+strings.TrimLeft(contents, "\t ")+"\n")
	review, err := r.Resolve(context.Background(), Selection{Base: "HEAD", IgnoreWhitespace: true})
	if err != nil {
		t.Fatal(err)
	}
	f := statFor(t, review, "renamed.txt")
	if f.Status != "renamed" || f.Additions != 0 || f.Deletions != 0 {
		t.Fatalf("rename metadata was lost: %+v", f)
	}
	files, err := review.Context(context.Background(), f.Path, *f.Hash)
	if err != nil || files.OldFile != nil || !strings.Contains(files.NewFile.Contents, "line_30=999") {
		t.Fatalf("filtered pure-rename context: %+v %v", files, err)
	}
}
