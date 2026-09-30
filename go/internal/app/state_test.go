package app

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestConcurrentStateAndPersistence(t *testing.T) {
	s := &Store{path: filepath.Join(t.TempDir(), "ghl-go-poc", "state.json")}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprint(i)
			hash := "hash-" + id
			_, err := s.Mutate(func(state *StoredState) error {
				upsert(state, Comment{ID: id, Path: "file-" + id, Side: "additions", Start: 1, End: 1, Anchor: []string{"code"}, Range: "base..head", CreatedAt: "original"})
				if state.Viewed["base..head"] == nil {
					state.Viewed["base..head"] = ViewedMap{}
				}
				state.Viewed["base..head"][id] = &hash
				return nil
			})
			if err != nil {
				t.Error(err)
			}
			if _, _, err := s.Snapshot(); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	restarted := &Store{path: s.path}
	state, notice, err := restarted.Snapshot()
	if err != nil || notice != nil || len(state.Comments) != 32 || len(state.Viewed["base..head"]) != 32 {
		t.Fatalf("lost writes: %+v %v", state, err)
	}
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Mutate(func(state *StoredState) error {
				c := state.Comments[0]
				c.Body, c.CreatedAt = "edited", "new"
				upsert(state, c)
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	state, _, err = s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Comments) != 32 || state.Comments[0].CreatedAt != "original" {
		t.Fatal("duplicate edit or changed timestamp")
	}
	_, err = s.Mutate(func(state *StoredState) error { state.Comments = state.Comments[1:]; return nil })
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = s.Snapshot()
	if err != nil || len(state.Comments) != 31 || len(state.Viewed["base..head"]) != 32 {
		t.Fatal("delete affected other state")
	}
}
func TestCorruptionNotice(t *testing.T) {
	for _, raw := range []string{"{", "null", `{"version":1,"comments":"wrong"}`, `{"version":2,"viewed":{},"comments":[]}`} {
		s := &Store{path: filepath.Join(t.TempDir(), "state.json")}
		if err := os.WriteFile(s.path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		state, notice, err := s.Snapshot()
		if err != nil || notice == nil || len(state.Comments) != 0 {
			t.Fatalf("corruption swallowed: %+v %v %v", state, notice, err)
		}
		files, _ := filepath.Glob(s.path + ".*.corrupt")
		if len(files) != 1 {
			t.Fatal("missing backup")
		}
		if _, notice, err := s.Snapshot(); err != nil || notice == nil {
			t.Fatal("notice lost before UI read")
		}
	}
}
