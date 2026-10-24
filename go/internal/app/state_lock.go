package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// stateLock serializes the writers of one state file across processes: the app,
// `ghl comments` and development servers. The kernel releases a flock when its
// process dies, so a crash never strands it.
func stateLock(ctx context.Context, path string) (func() error, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return file.Close, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			file.Close()
			return nil, err
		}
		select {
		case <-wait.Done():
			file.Close()
			return nil, fmt.Errorf("State is busy; retry after the other writer finishes: %w", wait.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
}
