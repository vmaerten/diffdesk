package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
)

type StateImport struct {
	Comments int     `json:"comments"`
	Viewed   int     `json:"viewed"`
	Backup   *string `json:"backup"`
}

// Import a snapshot without changing its source. Conflicts abort the entire
// import; an exact backup of an existing destination makes rollback possible.
func (s *Store) Import(ctx context.Context, source string) (result StateImport, err error) {
	raw, err := os.ReadFile(source)
	if err != nil {
		return result, err
	}
	incoming, err := decodeState(raw)
	if err != nil {
		return result, fmt.Errorf("Cannot import %s: %w", source, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	unlock, err := stateLock(ctx, s.gitDir, filepath.Base(filepath.Dir(s.path)))
	if err != nil {
		return result, err
	}
	defer func() {
		if release := unlock(); err == nil {
			err = release
		}
	}()
	state, err := s.read()
	if err != nil {
		return result, err
	}
	byID := make(map[string]Comment, len(state.Comments))
	for _, c := range state.Comments {
		byID[c.ID] = c
	}
	for _, c := range incoming.Comments {
		if old, exists := byID[c.ID]; exists {
			if !reflect.DeepEqual(old, c) {
				return result, fmt.Errorf("Import conflict for comment %q; destination and source were left unchanged", c.ID)
			}
			continue
		}
		byID[c.ID] = c
		state.Comments = append(state.Comments, c)
		result.Comments++
	}
	for comparison, viewed := range incoming.Viewed {
		if state.Viewed[comparison] == nil {
			state.Viewed[comparison] = ViewedMap{}
		}
		for path, hash := range viewed {
			if old, exists := state.Viewed[comparison][path]; exists {
				if !reflect.DeepEqual(old, hash) {
					return result, fmt.Errorf("Import conflict for Viewed %q in %q; destination and source were left unchanged", path, comparison)
				}
				continue
			}
			state.Viewed[comparison][path] = hash
			result.Viewed++
		}
	}
	if result.Comments == 0 && result.Viewed == 0 {
		return result, nil
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	previous, err := os.ReadFile(s.path)
	if err != nil && !os.IsNotExist(err) {
		return result, err
	}
	if err == nil {
		backup, err := os.CreateTemp(filepath.Dir(s.path), "state-import-*.backup")
		if err != nil {
			return result, err
		}
		name := backup.Name()
		result.Backup = &name
		_, err = backup.Write(previous)
		if err == nil {
			err = backup.Sync()
		}
		closeErr := backup.Close()
		if err != nil {
			return result, err
		}
		if closeErr != nil {
			return result, closeErr
		}
	}
	return result, s.write(state)
}
