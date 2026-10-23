package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ghl Desktop", "settings.json")
	store := &settingsStore{path: path}

	if raw, err := store.load(); err != nil || raw != "" {
		t.Fatalf("missing file: got %q, %v; want the UI defaults", raw, err)
	}

	saved := `{"version":1,"appearance":"dark","codeSize":14}`
	if err := store.save(saved); err != nil {
		t.Fatal(err)
	}
	if raw, err := store.load(); err != nil || raw != saved {
		t.Fatalf("round trip: got %q, %v", raw, err)
	}

	for _, invalid := range []string{`{"version":2}`, `{"appearance":"dark"}`, `not json`} {
		if err := store.save(invalid); err == nil {
			t.Errorf("saved %s", invalid)
		}
		if err := os.WriteFile(path, []byte(invalid), 0o644); err != nil {
			t.Fatal(err)
		}
		if raw, err := store.load(); err != nil || raw != "" {
			t.Errorf("stored %s: got %q, %v; want the UI defaults", invalid, raw, err)
		}
	}
}
