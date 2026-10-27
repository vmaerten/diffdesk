package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestDebugLogRetainsEveryEventAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Diffdesk", "settings.json")
	store := &settingsStore{path: path}
	if raw, err := store.readDebugLog(); err != nil || raw != "" {
		t.Fatalf("missing log: %q, %v", raw, err)
	}
	var writers sync.WaitGroup
	for worker := range 10 {
		writers.Go(func() {
			for sequence := range 100 {
				raw := fmt.Sprintf(`{"time":"2026-10-26T20:00:00Z","page":"%d","event":"scroll.jump","details":{"sequence":%d}}`, worker, sequence)
				if err := store.appendDebugEvent(raw); err != nil {
					t.Error(err)
					return
				}
			}
		})
	}
	writers.Wait()
	reopened := &settingsStore{path: path}
	raw, err := reopened.readDebugLog()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	if len(lines) != 1000 {
		t.Fatalf("kept %d events, want all 1000", len(lines))
	}
	seen := map[string]bool{}
	for _, line := range lines {
		var event struct {
			Page    string
			Details struct{ Sequence int }
		}
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("interleaved event: %s: %v", line, err)
		}
		key := fmt.Sprintf("%s:%d", event.Page, event.Details.Sequence)
		if seen[key] {
			t.Fatalf("duplicate event %s", key)
		}
		seen[key] = true
	}
	info, err := os.Stat(filepath.Join(filepath.Dir(path), "debug.log"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("log permissions: %v", info.Mode())
	}
	if err := reopened.clearDebugLog(); err != nil {
		t.Fatal(err)
	}
	if raw, err := store.readDebugLog(); err != nil || raw != "" {
		t.Fatalf("cleared log: %q, %v", raw, err)
	}
	if err := store.clearDebugLog(); err != nil {
		t.Fatal(err)
	}
}

func TestDebugLogRejectsInvalidEventsWithoutChangingHistory(t *testing.T) {
	store := &settingsStore{path: filepath.Join(t.TempDir(), "settings.json")}
	valid := "{\n\"time\":\"now\",\"page\":\"one\",\"event\":\"comment.open\"\n}"
	if err := store.appendDebugEvent(valid); err != nil {
		t.Fatal(err)
	}
	before, _ := store.readDebugLog()
	if strings.Count(before, "\n") != 1 {
		t.Fatalf("event spans multiple lines: %q", before)
	}
	for _, invalid := range []string{"not json", "null", "{}", `{"time":"now","page":"one"}`, valid + valid} {
		if err := store.appendDebugEvent(invalid); err == nil {
			t.Errorf("accepted %q", invalid)
		}
	}
	if after, _ := store.readDebugLog(); after != before {
		t.Fatal("invalid events changed the history")
	}
}
