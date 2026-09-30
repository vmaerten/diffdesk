package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// A process owns one repository. Every disk read and read/modify/write holds mu.
type Store struct {
	mu     sync.Mutex
	path   string
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
	var state StoredState
	err = json.Unmarshal(raw, &state)
	if err == nil && state.Version == 1 && state.Viewed != nil && state.Comments != nil {
		valid := true
		for _, c := range state.Comments {
			if c.ID == "" || !validPath(c.Path) || !validLocation(c) || c.Anchor == nil || c.Range == "" || c.CreatedAt == "" {
				valid = false
			}
		}
		for _, viewed := range state.Viewed {
			if viewed == nil {
				valid = false
			}
		}
		if valid {
			return state, nil
		}
	}
	aside := fmt.Sprintf("%s.%d.corrupt", s.path, time.Now().UnixNano())
	if err := os.Rename(s.path, aside); err != nil {
		return StoredState{}, err
	}
	notice := fmt.Sprintf("%s could not be read and was moved to %s; starting from an empty state", s.path, aside)
	s.notice = &notice
	return emptyState(), nil
}

func (s *Store) Snapshot() (StoredState, *string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.read()
	return state, s.notice, err
}

func (s *Store) Mutate(change func(*StoredState) error) (StoredState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.read()
	if err != nil {
		return state, err
	}
	if err = change(&state); err != nil {
		return state, err
	}
	if err = os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return state, err
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return state, err
	}
	file, err := os.CreateTemp(filepath.Dir(s.path), "state-*.tmp")
	if err != nil {
		return state, err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return state, err
	}
	if closeErr != nil {
		return state, closeErr
	}
	err = os.Rename(file.Name(), s.path)
	return state, err
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
