package app

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestStateImportIsRecoverableAndIdempotent(t *testing.T) {
	s := stateFixture(t)
	c := Comment{ID: "original", Path: "renamed é.txt", Side: "deletions", Start: 11, End: 12, Body: "original", Anchor: []string{"before", "rename"}, Range: "main..feature", CreatedAt: "2020-01-01T00:00:00.000Z"}
	_, err := s.Mutate(context.Background(), func(state *StoredState) error { state.Comments = append(state.Comments, c); return nil })
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(s.path)
	c.ID = "imported"
	incoming := emptyState()
	incoming.Comments = []Comment{c}
	hash := "123456789abc"
	incoming.Viewed["main..feature"] = ViewedMap{"renamed é.txt": &hash, "binary": nil}
	raw, _ := json.Marshal(incoming)
	source := filepath.Join(t.TempDir(), "source.json")
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := s.Import(context.Background(), source)
	if err != nil || result.Comments != 1 || result.Viewed != 2 || result.Backup == nil {
		t.Fatalf("import: %+v %v", result, err)
	}
	backup, _ := os.ReadFile(*result.Backup)
	untouched, _ := os.ReadFile(source)
	if !bytes.Equal(backup, before) || !bytes.Equal(untouched, raw) {
		t.Fatal("backup or source changed")
	}
	state, _, err := s.Snapshot(context.Background())
	if err != nil || len(state.Comments) != 2 || state.Comments[1].CreatedAt != c.CreatedAt {
		t.Fatal("records or timestamp lost")
	}
	result, err = s.Import(context.Background(), source)
	if err != nil || result.Comments != 0 || result.Viewed != 0 || result.Backup != nil {
		t.Fatalf("not idempotent: %+v %v", result, err)
	}
	c.Body = "conflicting body"
	incoming.Comments[0] = c
	raw, _ = json.Marshal(incoming)
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ = os.ReadFile(s.path)
	if _, err := s.Import(context.Background(), source); err == nil {
		t.Fatal("conflicting import accepted")
	}
	after, _ := os.ReadFile(s.path)
	if !bytes.Equal(before, after) {
		t.Fatal("conflict partially changed state")
	}
	incoming.Comments = []Comment{}
	changedHash := "different"
	incoming.Viewed["main..feature"]["renamed é.txt"] = &changedHash
	raw, _ = json.Marshal(incoming)
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Import(context.Background(), source); err == nil {
		t.Fatal("conflicting Viewed hash accepted")
	}
	after, _ = os.ReadFile(s.path)
	if !bytes.Equal(before, after) {
		t.Fatal("Viewed conflict partially changed state")
	}
}

func TestImportCommandDoesNotRequireCommitOrAssets(t *testing.T) {
	root := t.TempDir()
	gitFixture(t, root, "init", "-q", "-b", "main")
	state := emptyState()
	state.Comments = []Comment{{ID: "imported", Path: "file.txt", Side: "additions", Start: 1, End: 1, Body: "body", Anchor: []string{"code"}, Range: "main..HEAD", CreatedAt: "2020-01-01T00:00:00.000Z"}}
	raw, _ := json.Marshal(state)
	source := filepath.Join(root, "snapshot.json")
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Main(context.Background(), []string{"--repo", root, "--import-state", source, "--json"}, &stdout, &stderr, Options{})
	if code != 0 || stderr.Len() != 0 || !json.Valid(stdout.Bytes()) {
		t.Fatalf("import started review/runtime: %d %s %s", code, stdout.String(), stderr.String())
	}
	saved, err := os.ReadFile(filepath.Join(root, ".git", "ghl", "state.json"))
	if err != nil || !bytes.Contains(saved, []byte(`"id": "imported"`)) {
		t.Fatalf("state not imported: %s %v", saved, err)
	}
}
