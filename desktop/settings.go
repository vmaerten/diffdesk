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
	// Read while path does not exist yet: where the app kept them as "ghl Desktop".
	legacy string
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
	return &settingsStore{
		path:   filepath.Join(dir, "ghl", "settings.json"),
		legacy: filepath.Join(dir, "ghl Desktop", "settings.json"),
	}, nil
}

// isVersionOne accepts a bounded JSON document at version 1, the shape of every
// document the page hands Go to keep.
func isVersionOne(raw []byte, limit int) bool {
	var header struct {
		Version int `json:"version"`
	}
	return len(raw) <= limit && json.Unmarshal(raw, &header) == nil && header.Version == 1
}

const settingsLimit = 64 * 1024

// load returns "" when nothing usable is stored, and the UI then keeps its defaults.
func (s *settingsStore) load() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) && s.legacy != "" {
		raw, err = os.ReadFile(s.legacy)
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !isVersionOne(raw, settingsLimit) {
		return "", nil
	}
	return string(raw), nil
}

func (s *settingsStore) save(raw string) error {
	if !isVersionOne([]byte(raw), settingsLimit) {
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
