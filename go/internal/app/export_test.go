package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestSharedExportGoldens(t *testing.T) {
	raw, err := os.ReadFile("testdata/comment-export.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Repo, Range, Text string
		Comments              []ServedComment
		Export                json.RawMessage
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		var text, exported bytes.Buffer
		if err := writeCommentExport(fixture.Comments, fixture.Repo, fixture.Range, ExportOptions{}, &text); err != nil {
			t.Fatal(err)
		}
		if text.String() != fixture.Text {
			t.Fatalf("text contract:\n%s", text.String())
		}
		if err := writeCommentExport(fixture.Comments, fixture.Repo, fixture.Range, ExportOptions{JSON: true}, &exported); err != nil {
			t.Fatal(err)
		}
		var actual, expected any
		if err := json.Unmarshal(exported.Bytes(), &actual); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(fixture.Export, &expected); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("JSON contract: %s", exported.String())
		}
	}
}

func TestReadingOrderIsStableAndIndependentOfLocale(t *testing.T) {
	comments := []ServedComment{
		{Comment: Comment{ID: "private", Path: "\ue000.txt", Start: 1}},
		{Comment: Comment{ID: "emoji", Path: "😀.txt", Start: 1}},
		{Comment: Comment{ID: "lower", Path: "a.txt", Start: 1}},
		{Comment: Comment{ID: "upper", Path: "A.txt", Start: 1}},
		{Comment: Comment{ID: "tie", Path: "A.txt", Start: 1}},
	}
	var ids []string
	for _, c := range readingOrder(comments) {
		ids = append(ids, c.ID)
	}
	if strings.Join(ids, ",") != "upper,tie,lower,emoji,private" || comments[0].ID != "private" {
		t.Fatalf("order or input mutation: %v", ids)
	}
}

func TestExportKeepsCurrentFilesAndReportsCorruption(t *testing.T) {
	ctx := context.Background()
	r := fixture(t)
	store := storeFor(r)
	_, err := store.Mutate(context.Background(), func(state *StoredState) error {
		for id, path := range map[string]string{"current": "context.txt", "outside": "old name é.txt", "untracked": "untracked.txt"} {
			state.Comments = append(state.Comments, Comment{ID: id, Path: path, Side: "additions", Start: 10, End: 10, Body: id, Anchor: []string{"old"}, Range: "historic..feature", CreatedAt: "2020-01-01T00:00:00.000Z"})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err = ExportComments(ctx, r.Path, Selection{Base: "main"}, ExportOptions{JSON: true}, &stdout, &stderr)
	if err != nil || stderr.Len() != 0 || !strings.Contains(stdout.String(), `"id": "current"`) || !strings.Contains(stdout.String(), `"id": "untracked"`) || strings.Contains(stdout.String(), `"id": "outside"`) {
		t.Fatalf("wrong selection: %v %s %s", err, stdout.String(), stderr.String())
	}
	if err := os.WriteFile(store.path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	err = ExportComments(ctx, r.Path, Selection{Base: "main"}, ExportOptions{JSON: true}, &stdout, &stderr)
	if err != nil || !json.Valid(stdout.Bytes()) || !strings.Contains(stderr.String(), ".corrupt") {
		t.Fatalf("corruption lost or polluted JSON: %v %s %s", err, stdout.String(), stderr.String())
	}
}
