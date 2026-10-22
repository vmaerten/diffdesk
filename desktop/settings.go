package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// settingsStore keeps the desktop settings between launches. Their schema
// belongs to the UI; this side only keeps a bounded, versioned JSON document.
type settingsStore struct {
	mu   sync.Mutex
	path string
}

// newSettingsStore uses GHL_DESKTOP_SETTINGS when set, so tests never touch
// the user's own settings.
func newSettingsStore() (*settingsStore, error) {
	if path := os.Getenv("GHL_DESKTOP_SETTINGS"); path != "" {
		return &settingsStore{path: path}, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return &settingsStore{path: filepath.Join(dir, "ghl Desktop", "settings.json")}, nil
}

func validSettings(raw []byte) bool {
	if len(raw) > 64*1024 || !json.Valid(raw) {
		return false
	}
	var header struct {
		Version int `json:"version"`
	}
	return json.Unmarshal(raw, &header) == nil && header.Version == 1
}

// load returns "" when nothing usable is stored, and the UI then keeps its defaults.
func (s *settingsStore) load() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !validSettings(raw) {
		return "", nil
	}
	return string(raw), nil
}

func (s *settingsStore) save(raw string) error {
	if !validSettings([]byte(raw)) {
		return errors.New("settings must be version-1 JSON under 64 KiB")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	// A crash mid-write leaves the previous settings, never a truncated file.
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".settings-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.WriteString(raw); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), s.path)
}

func (d *desktopApp) Settings() (string, error)     { return d.settings.load() }
func (d *desktopApp) SaveSettings(raw string) error { return d.settings.save(raw) }
