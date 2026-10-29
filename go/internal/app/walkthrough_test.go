package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// test/hunks.ts numbers the same patches with the page's parser.
func TestHunkIDsMatchThePage(t *testing.T) {
	raw, err := os.ReadFile("testdata/walkthrough-hunks.json")
	if err != nil {
		t.Fatal(err)
	}
	var goldens []struct {
		Patch string
		Files []struct{ Path, Previous string }
		Hunks []string
	}
	if err := json.Unmarshal(raw, &goldens); err != nil {
		t.Fatal(err)
	}
	for i, golden := range goldens {
		review := &Review{Patch: golden.Patch, sections: map[string]*section{}}
		previous := map[string]string{}
		for _, file := range golden.Files {
			review.Files = append(review.Files, FileStat{Path: file.Path})
			if file.Previous != "" {
				previous[file.Path] = file.Previous
			}
		}
		review.parseSections(previous)
		var ids []string
		for _, h := range review.hunks() {
			ids = append(ids, h.ID)
		}
		if strings.Join(ids, "\n") != strings.Join(golden.Hunks, "\n") {
			t.Errorf("golden %d: %v, want %v", i, ids, golden.Hunks)
		}
	}
}

func TestWalkthroughValidation(t *testing.T) {
	hunks := []hunk{{ID: "a.go#1", Path: "a.go", N: 1}, {ID: "a.go#2", Path: "a.go", N: 2}, {ID: "b.go#1", Path: "b.go", N: 1}}
	valid := `{"version":1,"title":"T","chapters":[{"title":"C","stops":[{"title":"S","summary":"s","hunks":["a.go#1","b.go#1"]}]}],"support":[{"note":"n","hunks":["a.go#2"]}]}`
	manyStops := strings.Repeat(`{"title":"S","summary":"s","hunks":["a.go#1"]},`, maxStops)
	for _, test := range []struct{ name, document, problem string }{
		{"valid", valid, ""},
		{"unknown rank", strings.Replace(valid, `"b.go#1"`, `"a.go#3"`, 1), `unknown hunk "a.go#3": a.go has #1 to #2`},
		{"unknown file", strings.Replace(valid, `"b.go#1"`, `"c.go#1"`, 1), `no hunk in "c.go"`},
		{"cited twice", strings.Replace(valid, `"a.go#2"`, `"a.go#1"`, 1), `"a.go#1" is cited twice`},
		{"no summary", strings.Replace(valid, `"summary":"s",`, "", 1), "stops[0]: summary is required"},
		{"too many stops", `{"version":1,"title":"T","chapters":[{"title":"C","stops":[` + manyStops + `{"title":"S","summary":"s","hunks":["b.go#1"]}]}]}`, "15 stops given, 14 at most"},
		{"version", strings.Replace(valid, `"version":1`, `"version":2`, 1), "version must be 1"},
	} {
		w, err := decodeWalkthrough(strings.NewReader(test.document))
		if err != nil {
			t.Fatalf("%s: %v", test.name, err)
		}
		problems := strings.Join(w.validate(hunks), "\n")
		if test.problem == "" && problems != "" || !strings.Contains(problems, test.problem) {
			t.Errorf("%s: %q, want %q", test.name, problems, test.problem)
		}
	}
	if _, err := decodeWalkthrough(strings.NewReader(strings.Replace(valid, `"title":"T"`, `"title":"T","icon":"x"`, 1))); err == nil {
		t.Error("an unknown field was accepted")
	}
}

func TestWalkthroughFindsItsHunksAgain(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir()
	gitFixture(t, path, "init", "-q", "-b", "main")
	gitFixture(t, path, "config", "user.name", "Fixture")
	gitFixture(t, path, "config", "user.email", "fixture@example.invalid")
	var lines strings.Builder
	for i := 1; i <= 100; i++ {
		fmt.Fprintf(&lines, "line %d\n", i)
	}
	original := lines.String()
	writeFixture(t, path, "code.txt", original)
	writeFixture(t, path, "notes.txt", "notes\n")
	gitFixture(t, path, "add", ".")
	gitFixture(t, path, "commit", "-qm", "base")
	gitFixture(t, path, "checkout", "-qb", "feature")
	writeFixture(t, path, "code.txt", strings.Replace(original, "line 50\n", "changed 50\n", 1))
	writeFixture(t, path, "notes.txt", "notes, edited\n")
	selection := Selection{Base: "main"}
	show := func() string {
		var out bytes.Buffer
		if err := ShowWalkthrough(ctx, path, selection, &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}

	document := `{"version":1,"title":"Tour","chapters":[{"title":"Code","stops":[{"title":"The change","summary":"Line 50 changes.","hunks":["code.txt#1"]}]}]}`
	var out bytes.Buffer
	if err := SetWalkthrough(ctx, path, selection, strings.NewReader(document), &out); err != nil || out.String() != "Walkthrough saved for feature: 1 stops, 1 of 2 hunks.\n" {
		t.Fatalf("set: %v %q", err, out.String())
	}
	if got := show(); !strings.Contains(got, "  1.1 The change\n    Line 50 changes.\n    code.txt#1\n") || !strings.Contains(got, "Not in the walkthrough: notes.txt#1") {
		t.Fatalf("show:\n%s", got)
	}

	// A hunk added above renumbers the cited one; its content still finds it.
	writeFixture(t, path, "code.txt", strings.Replace(strings.Replace(original, "line 50\n", "changed 50\n", 1), "line 5\n", "changed 5\n", 1))
	if got := show(); !strings.Contains(got, "    code.txt#2\n") || !strings.Contains(got, "Not in the walkthrough: code.txt#1, notes.txt#1") {
		t.Fatalf("after a hunk above:\n%s", got)
	}

	// Edited in place, the hunk at its rank still carries the stop.
	writeFixture(t, path, "code.txt", strings.Replace(original, "line 50\n", "edited 50\n", 1))
	if got := show(); !strings.Contains(got, "    code.txt#1\n") || strings.Contains(got, "Stale") {
		t.Fatalf("after an edit:\n%s", got)
	}

	writeFixture(t, path, "code.txt", original)
	if got := show(); !strings.Contains(got, "code.txt#1 (gone)") || !strings.Contains(got, "Stale:") {
		t.Fatalf("after a revert:\n%s", got)
	}

	if err := SetWalkthrough(ctx, path, selection, strings.NewReader(document), &out); err == nil || !strings.Contains(err.Error(), `unknown hunk "code.txt#1": no hunk in "code.txt"`) {
		t.Fatalf("set on a diff without the hunk: %v", err)
	}
	out.Reset()
	if err := ClearWalkthrough(ctx, path, selection, &out); err != nil || out.String() != "Walkthrough cleared for feature.\n" {
		t.Fatalf("clear: %v %q", err, out.String())
	}
	if got := show(); got != "No walkthrough for feature.\n" {
		t.Fatalf("after clear: %q", got)
	}
}
