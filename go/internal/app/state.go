package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// mu protects the notice; stateLock serializes writers across Store instances
// and processes. Readers take no lock: every write renames a complete file.
type Store struct {
	mu     sync.Mutex
	path   string
	notice *string
}

// Version 2 added comment status and replies. Writing it makes an older
// runtime refuse the file rather than rewrite comments without them.
const stateVersion = 2

func emptyState() StoredState {
	return StoredState{Version: stateVersion, Viewed: map[string]ViewedMap{}, Comments: []Comment{}}
}

// Reading a filtered diff must not mark its hidden whitespace changes as read.
// '?' cannot occur in a Git ref, so this does not collide with a normal range.
func viewedRange(comparison string, ignoreWhitespace bool) string {
	if ignoreWhitespace {
		return comparison + "?w=1"
	}
	return comparison
}

type corruptState struct{ err error }

func (c corruptState) Error() string { return c.err.Error() }

func (s *Store) read() (StoredState, error) {
	raw, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return emptyState(), nil
	}
	if err != nil {
		return StoredState{}, err
	}
	state, err := decodeState(raw)
	var unsupported unsupportedStateVersion
	if err != nil && !errors.As(err, &unsupported) {
		return emptyState(), corruptState{err}
	}
	return state, err
}

// quarantine moves a corrupt file aside before a write replaces it.
func (s *Store) quarantine() error {
	aside := fmt.Sprintf("%s.%d.corrupt", s.path, time.Now().UnixNano())
	if err := os.Rename(s.path, aside); err != nil {
		return err
	}
	notice := fmt.Sprintf("%s could not be read and was moved to %s; starting from an empty state", s.path, aside)
	s.notice = &notice
	return nil
}

type unsupportedStateVersion int

func (v unsupportedStateVersion) Error() string {
	return fmt.Sprintf("Unsupported review state version %d; use a compatible runtime. The file was left unchanged", v)
}

// Version-1 Node states may predate the version field or omit empty collections.
// Never quarantine a future schema as corruption: that would enable data loss.
func decodeState(raw []byte) (StoredState, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return StoredState{}, fmt.Errorf("Review state must be an object")
	}
	var version = 1
	if value := object["version"]; value != nil && string(value) != "null" {
		if err := json.Unmarshal(value, &version); err != nil {
			return StoredState{}, err
		}
	}
	if version != 1 && version != stateVersion {
		return StoredState{}, unsupportedStateVersion(version)
	}
	state := emptyState()
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, err
	}
	state.Version = stateVersion
	if state.Viewed == nil {
		state.Viewed = map[string]ViewedMap{}
	}
	if state.Comments == nil {
		state.Comments = []Comment{}
	}
	for i := range state.Comments {
		c := &state.Comments[i]
		if c.Status == "" {
			c.Status = statusOpen
		}
		if c.ID == "" || !validPath(c.Path) || !validLocation(*c) || c.Anchor == nil || c.Range == "" || c.CreatedAt == "" || !validThread(*c) {
			return state, fmt.Errorf("Invalid comment in review state")
		}
	}
	for _, viewed := range state.Viewed {
		if viewed == nil {
			return state, fmt.Errorf("Invalid Viewed map in review state")
		}
	}
	return state, nil
}

// Snapshot never changes the disk: a corrupt file stays in place, reported as
// empty state with a notice, until a write moves it aside.
func (s *Store) Snapshot() (StoredState, *string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.read()
	var corrupt corruptState
	if errors.As(err, &corrupt) {
		notice := fmt.Sprintf("%s could not be read (%v); showing an empty state until the next change moves it to a .corrupt backup", s.path, corrupt.err)
		return state, &notice, nil
	}
	return state, s.notice, err
}

func (s *Store) Mutate(ctx context.Context, change func(*StoredState) error) (state StoredState, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := stateLock(ctx, s.path+".lock")
	if err != nil {
		return state, err
	}
	defer func() {
		if release := unlock(); err == nil {
			err = release
		}
	}()
	state, err = s.read()
	if errors.As(err, new(corruptState)) {
		err = s.quarantine()
	}
	if err != nil {
		return state, err
	}
	if err = change(&state); err != nil {
		return state, err
	}
	if err = ctx.Err(); err != nil {
		return state, err
	}
	return state, s.write(state)
}

func (s *Store) write(state StoredState) error {
	var err error
	if err = os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), "state-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	err = os.Rename(file.Name(), s.path)
	return err
}
