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
	gitFixture(t, root, "init", "-q", "--bare")
	if err := os.MkdirAll(filepath.Join(root, "ghl"), 0700); err != nil {
		t.Fatal(err)
	}
	return &Store{gitDir: root, path: filepath.Join(root, "ghl", "state.json")}
}

func TestIndependentStoresSerializeTransactions(t *testing.T) {
	s := stateFixture(t)
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			other := &Store{path: s.path, gitDir: s.gitDir}
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
	state, _, err := s.Snapshot(context.Background())
	if err != nil || len(state.Comments) != 20 {
		t.Fatalf("lost concurrent writes: %+v %v", state, err)
	}
}

func TestFutureSchemaIsLeftUntouched(t *testing.T) {
	s := stateFixture(t)
	raw := []byte(`{"version":2,"viewed":{},"comments":[]}`)
	if err := os.WriteFile(s.path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Snapshot(context.Background()); err == nil {
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

func TestLockWaitHonorsCancellation(t *testing.T) {
	s := stateFixture(t)
	release, err := stateLock(context.Background(), s.gitDir, "ghl")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := s.Snapshot(ctx); err == nil {
		t.Fatal("read bypassed the writer lock")
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
	cmd.Env = append(os.Environ(), "GHL_STATE_CRASH_DIR="+s.gitDir)
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
	if _, _, err := s.Snapshot(ctx); err != nil {
		t.Fatalf("crash stranded a lock: %v", err)
	}
	after, err := os.ReadFile(s.path)
	if err != nil || !bytes.Equal(before, after) || !json.Valid(after) {
		t.Fatal("interrupted write damaged state")
	}
}

func TestStateCrashWorker(t *testing.T) {
	root := os.Getenv("GHL_STATE_CRASH_DIR")
	if root == "" {
		return
	}
	s := &Store{gitDir: root, path: filepath.Join(root, "ghl", "state.json")}
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
			if _, _, err := s.Snapshot(context.Background()); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	restarted := &Store{path: s.path, gitDir: s.gitDir}
	state, notice, err := restarted.Snapshot(context.Background())
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
	state, _, err = s.Snapshot(context.Background())
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
	state, _, err = s.Snapshot(context.Background())
	if err != nil || len(state.Comments) != 31 || len(state.Viewed["base..head"]) != 32 {
		t.Fatal("delete affected other state")
	}
}
func TestCorruptionNotice(t *testing.T) {
	for _, raw := range []string{"{", "null", `{"version":1,"comments":"wrong"}`} {
		s := stateFixture(t)
		if err := os.WriteFile(s.path, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		state, notice, err := s.Snapshot(context.Background())
		if err != nil || notice == nil || len(state.Comments) != 0 {
			t.Fatalf("corruption swallowed: %+v %v %v", state, notice, err)
		}
		files, _ := filepath.Glob(s.path + ".*.corrupt")
		if len(files) != 1 {
			t.Fatal("missing backup")
		}
		if _, notice, err := s.Snapshot(context.Background()); err != nil || notice == nil {
			t.Fatal("notice lost before UI read")
		}
	}
}
