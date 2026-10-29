package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// The append-only trace lives beside settings.json. No rotation or pruning:
// disabling logging preserves the file; only ClearDebugLog removes it.
func (s *settingsStore) appendDebugEvent(raw string) error {
	var event struct {
		Time  string `json:"time"`
		Page  string `json:"page"`
		Event string `json:"event"`
	}
	if json.Unmarshal([]byte(raw), &event) != nil || event.Time == "" || event.Page == "" || event.Event == "" {
		return errors.New("expected a debug event with time, page and event")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, []byte(raw)); err != nil {
		return err
	}
	compact.WriteByte('\n')
	s.debugMu.Lock()
	defer s.debugMu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(filepath.Dir(s.path), "debug.log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(file, &compact)
	return errors.Join(err, file.Close())
}

// recordNativeEvent logs what no page can report, such as its own renderer
// dying, when the settings have debug logging on.
func (s *settingsStore) recordNativeEvent(event string, details map[string]any) error {
	raw, err := s.load()
	var stored struct {
		DebugLogging bool `json:"debugLogging"`
	}
	if err != nil || raw == "" || json.Unmarshal([]byte(raw), &stored) != nil || !stored.DebugLogging {
		return err
	}
	line, err := json.Marshal(map[string]any{
		"time":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		"page":    "native",
		"event":   event,
		"details": details,
	})
	if err != nil {
		return err
	}
	return s.appendDebugEvent(string(line))
}

func (s *settingsStore) readDebugLog() (string, error) {
	s.debugMu.Lock()
	defer s.debugMu.Unlock()
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(s.path), "debug.log"))
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	return string(raw), err
}

func (s *settingsStore) clearDebugLog() error {
	s.debugMu.Lock()
	defer s.debugMu.Unlock()
	err := os.Remove(filepath.Join(filepath.Dir(s.path), "debug.log"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (d *desktopApp) AppendDebugEvent(raw string) error { return d.settings.appendDebugEvent(raw) }
func (d *desktopApp) DebugLog() (string, error)         { return d.settings.readDebugLog() }
func (d *desktopApp) ClearDebugLog() error              { return d.settings.clearDebugLog() }
