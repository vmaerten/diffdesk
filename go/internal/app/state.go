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

// mu protects notices in memory; Git serializes complete disk transactions
// across Store instances, foreground servers, CLI commands and Node processes.
type Store struct {
	mu     sync.Mutex
	path   string
	gitDir string
	notice *string
}

func emptyState() StoredState {
	return StoredState{Version: 1, Viewed: map[string]ViewedMap{}, Comments: []Comment{}}
}

func (s *Store) read() (StoredState, error) {
	raw, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return emptyState(), nil
	}
	if err != nil {
		return StoredState{}, err
	}
	state, err := decodeState(raw)
	if err == nil {
		return state, nil
	}
	var unsupported unsupportedStateVersion
	if errors.As(err, &unsupported) {
		return state, err
	}
	aside := fmt.Sprintf("%s.%d.corrupt", s.path, time.Now().UnixNano())
	if err := os.Rename(s.path, aside); err != nil {
		return StoredState{}, err
	}
	notice := fmt.Sprintf("%s could not be read and was moved to %s; starting from an empty state", s.path, aside)
	s.notice = &notice
	return emptyState(), nil
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
	if version != 1 {
		return StoredState{}, unsupportedStateVersion(version)
	}
	state := emptyState()
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, err
	}
	state.Version = 1
	if state.Viewed == nil {
		state.Viewed = map[string]ViewedMap{}
	}
	if state.Comments == nil {
		state.Comments = []Comment{}
	}
	for _, c := range state.Comments {
		if c.ID == "" || !validPath(c.Path) || !validLocation(c) || c.Anchor == nil || c.Range == "" || c.CreatedAt == "" {
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

func (s *Store) Snapshot(ctx context.Context) (state StoredState, notice *string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := stateLock(ctx, s.gitDir, filepath.Base(filepath.Dir(s.path)))
	if err != nil {
		return state, nil, err
	}
	defer func() {
		if release := unlock(); err == nil {
			err = release
		}
	}()
	state, err = s.read()
	return state, s.notice, err
}

func (s *Store) Mutate(ctx context.Context, change func(*StoredState) error) (state StoredState, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := stateLock(ctx, s.gitDir, filepath.Base(filepath.Dir(s.path)))
	if err != nil {
		return state, err
	}
	defer func() {
		if release := unlock(); err == nil {
			err = release
		}
	}()
	state, err = s.read()
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

func upsert(state *StoredState, comment Comment) {
	for i, previous := range state.Comments {
		if previous.ID == comment.ID {
			comment.CreatedAt = previous.CreatedAt
			state.Comments[i] = comment
			return
		}
	}
	state.Comments = append(state.Comments, comment)
}
