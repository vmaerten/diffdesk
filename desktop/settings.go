package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// settingsStore keeps the desktop settings between launches. Their schema
// belongs to the UI; this side only keeps a bounded, versioned JSON document,
// and reads compactTitleBar, which the window needs before it exists.
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

// compactTitleBar says whether to open the window with the 38 px toolbar.
// Its style is fixed when the window is created, so a change applies at the
// next launch. Off unless the settings turn it on.
func (s *settingsStore) compactTitleBar() bool {
	raw, err := s.load()
	var stored struct {
		CompactTitleBar *bool `json:"compactTitleBar"`
	}
	if err != nil || raw == "" || json.Unmarshal([]byte(raw), &stored) != nil || stored.CompactTitleBar == nil {
		return false
	}
	return *stored.CompactTitleBar
}

func (d *desktopApp) Settings() (string, error) { return d.settings.load() }

// SaveSettings keeps what the Settings window changed and hands it to every
// window, so the review follows each change.
func (d *desktopApp) SaveSettings(raw string) error {
	if err := d.settings.save(raw); err != nil {
		return err
	}
	if app, _ := d.native(); app != nil {
		app.Event.Emit("desktop:settings", raw)
	}
	return nil
}

const settingsWindow = "settings"

// openSettings brings the Settings window forward, opening it the first time.
// Its height fits the tallest pane: Wails resizes a window from its bottom
// edge, where macOS settings windows keep their top in place.
func (d *desktopApp) openSettings() {
	app, _ := d.native()
	if app == nil {
		return
	}
	d.opening.Lock()
	defer d.opening.Unlock()
	if window, ok := app.Window.GetByName(settingsWindow); ok {
		window.Show()
		window.Focus()
		return
	}
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: settingsWindow, Title: "Settings", URL: "/settings",
		Width: 640, Height: 560, DisableResize: true,
		MinimiseButtonState: application.ButtonDisabled,
		MaximiseButtonState: application.ButtonDisabled,
		BackgroundType:      application.BackgroundTypeTranslucent,
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHidden,
			Backdrop: application.MacBackdropTranslucent,
		},
	})
}

func (d *desktopApp) closeSettings() {
	app, _ := d.native()
	if app == nil {
		return
	}
	if window, ok := app.Window.GetByName(settingsWindow); ok {
		window.Close()
	}
}
