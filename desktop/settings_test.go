package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ghl", "settings.json")
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

func TestSettingsStoreReadsTheLegacyFileUntilSaved(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "ghl Desktop", "settings.json")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o755); err != nil {
		t.Fatal(err)
	}
	old := `{"version":1,"appearance":"light"}`
	if err := os.WriteFile(legacy, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	store := &settingsStore{path: filepath.Join(dir, "ghl", "settings.json"), legacy: legacy}
	if raw, err := store.load(); err != nil || raw != old {
		t.Fatalf("legacy settings: got %q, %v", raw, err)
	}
	saved := `{"version":1,"appearance":"dark"}`
	if err := store.save(saved); err != nil {
		t.Fatal(err)
	}
	if raw, err := store.load(); err != nil || raw != saved {
		t.Fatalf("after saving: got %q, %v", raw, err)
	}
	if raw, err := os.ReadFile(legacy); err != nil || string(raw) != old {
		t.Fatalf("legacy file changed: %q, %v", raw, err)
	}
}
