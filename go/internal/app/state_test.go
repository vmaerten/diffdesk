package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func stateFixture(t *testing.T) *Store {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "ghl"), 0700); err != nil {
		t.Fatal(err)
	}
	return &Store{path: filepath.Join(root, "ghl", "state.json")}
}

func TestIndependentStoresSerializeTransactions(t *testing.T) {
	s := stateFixture(t)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			other := &Store{path: s.path}
			_, err := other.Mutate(context.Background(), func(state *StoredState) error {
				state.Comments = append(state.Comments, Comment{ID: fmt.Sprint(i), Path: "file.txt", Side: "deletions", Start: 1, End: 1, Range: "main..feature", Anchor: []string{"original"}, CreatedAt: "original"})
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	state, _, err := s.Snapshot()
	if err != nil || len(state.Comments) != 20 {
		t.Fatalf("lost concurrent writes: %+v %v", state, err)
	}
}

func TestFutureSchemaIsLeftUntouched(t *testing.T) {
	s := stateFixture(t)
	raw := []byte(`{"version":3,"viewed":{},"comments":[]}`)
	if err := os.WriteFile(s.path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Snapshot(); err == nil {
		t.Fatal("future schema accepted")
	}
	if _, err := s.Mutate(context.Background(), func(state *StoredState) error { return nil }); err == nil {
		t.Fatal("future schema overwritten")
	}
	actual, err := os.ReadFile(s.path)
	if err != nil || !bytes.Equal(actual, raw) {
		t.Fatal("future file changed")
	}
}

func TestVersionOneCommentsAreOpen(t *testing.T) {
	s := stateFixture(t)
	raw := `{"version":1,"viewed":{},"comments":[{"id":"c","path":"a.txt","side":"additions","start":1,"end":1,"body":"b","anchor":[],"range":"main..f","createdAt":"t"}]}`
	if err := os.WriteFile(s.path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Mutate(context.Background(), func(*StoredState) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var written StoredState
	if data, err := os.ReadFile(s.path); err != nil || json.Unmarshal(data, &written) != nil {
		t.Fatalf("unreadable state: %v", err)
	}
	if written.Version != 2 || written.Comments[0].Status != "open" {
		t.Fatalf("version 1 was not migrated: %+v", written)
	}
}

func TestWriterLockHoldsWritersOnly(t *testing.T) {
	s := stateFixture(t)
	release, err := stateLock(context.Background(), s.path+".lock")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if _, _, err := s.Snapshot(); err != nil {
		t.Fatalf("read waited for the writer: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := s.Mutate(ctx, func(*StoredState) error { return nil }); err == nil {
		t.Fatal("write bypassed the writer lock")
	}
}

func TestInterruptedWriterLeavesCompleteStateAndReleasesLock(t *testing.T) {
	s := stateFixture(t)
	_, err := s.Mutate(context.Background(), func(state *StoredState) error { state.Viewed["range"] = ViewedMap{}; return nil })
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestStateCrashWorker$")
	cmd.Env = append(os.Environ(), "DIFFDESK_STATE_CRASH_PATH="+s.path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	ready := make(chan bool, 1)
	go func() { scanner := bufio.NewScanner(out); ready <- scanner.Scan() && scanner.Text() == "ready" }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("worker did not acquire lock")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	release, err := stateLock(ctx, s.path+".lock")
	if err != nil {
		t.Fatalf("crash stranded the lock: %v", err)
	}
	release()
	after, err := os.ReadFile(s.path)
	if err != nil || !bytes.Equal(before, after) || !json.Valid(after) {
		t.Fatal("interrupted write damaged state")
	}
}

func TestStateCrashWorker(t *testing.T) {
	path := os.Getenv("DIFFDESK_STATE_CRASH_PATH")
	if path == "" {
		return
	}
	s := &Store{path: path}
	_, err := s.Mutate(context.Background(), func(state *StoredState) error {
		// A process can die while writing a new temporary file. Readers must
		// keep the previous complete state and ignore this unfinished write.
		if err := os.WriteFile(s.path+".interrupted.tmp", []byte(`{"version":`), 0600); err != nil {
			return err
		}
		fmt.Println("ready")
		select {}
	})
	t.Fatal(err)
}

func TestConcurrentStateAndPersistence(t *testing.T) {
	s := stateFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprint(i)
			hash := "hash-" + id
			_, err := s.Mutate(context.Background(), func(state *StoredState) error {
				state.Comments = append(state.Comments, Comment{ID: id, Path: "file-" + id, Side: "additions", Start: 1, End: 1, Anchor: []string{"code"}, Range: "base..head", CreatedAt: "original"})
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
			_, err := s.Mutate(context.Background(), func(state *StoredState) error {
				state.Comments[0].Body = "edited"
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
	if len(state.Comments) != 32 || state.Comments[0].Body != "edited" {
		t.Fatal("lost or duplicated state mutation")
	}
	_, err = s.Mutate(context.Background(), func(state *StoredState) error { state.Comments = state.Comments[1:]; return nil })
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = s.Snapshot()
	if err != nil || len(state.Comments) != 31 || len(state.Viewed["base..head"]) != 32 {
		t.Fatal("delete affected other state")
	}
}
func TestCorruptionNotice(t *testing.T) {
	unknownStatus := `{"version":2,"comments":[{"id":"c","path":"a.txt","side":"additions","start":1,"end":1,"anchor":[],"range":"main..f","createdAt":"t","status":"done"}]}`
	for _, raw := range []string{"{", "null", `{"version":1,"comments":"wrong"}`, unknownStatus} {
		s := stateFixture(t)
		if err := os.WriteFile(s.path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		state, notice, err := s.Snapshot()
		if err != nil || notice == nil || len(state.Comments) != 0 {
			t.Fatalf("corruption swallowed: %+v %v %v", state, notice, err)
		}
		// A read, such as `diffdesk comments`, leaves the file for the user to repair.
		if actual, err := os.ReadFile(s.path); err != nil || string(actual) != raw {
			t.Fatalf("read changed the corrupt file: %q %v", actual, err)
		}
		if _, err := s.Mutate(context.Background(), func(*StoredState) error { return nil }); err != nil {
			t.Fatal(err)
		}
		files, _ := filepath.Glob(s.path + ".*.corrupt")
		if len(files) != 1 {
			t.Fatal("missing backup")
		}
		if backup, err := os.ReadFile(files[0]); err != nil || string(backup) != raw {
			t.Fatalf("backup differs: %q %v", backup, err)
		}
		if _, notice, err := s.Snapshot(); err != nil || notice == nil {
			t.Fatal("notice lost before UI read")
		}
	}
}
