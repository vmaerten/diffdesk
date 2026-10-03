package app

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Node and Go use the same prepared Git transaction as a worktree-local lock.
// It never commits a ref. Closing stdin aborts the transaction, including when
// the parent process dies. Disable reference hooks: this is private bookkeeping.
func stateLock(ctx context.Context, gitDir, name string) (func() error, error) {
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		if err := wait.Err(); err != nil {
			return nil, fmt.Errorf("State is busy; retry after the other writer finishes: %w", err)
		}
		unlock, busy, err := tryStateLock(wait, gitDir, name)
		if err == nil {
			return unlock, nil
		}
		if !busy {
			return nil, err
		}
		select {
		case <-wait.Done():
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func tryStateLock(ctx context.Context, gitDir, name string) (func() error, bool, error) {
	cmd := exec.Command("git", "--git-dir="+gitDir, "-c", "core.hooksPath=/dev/null", "-c", "core.filesRefLockTimeout=0", "update-ref", "--stdin", "--no-deref")
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	stderr := limitedBuffer{limit: 64 * 1024}
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, false, err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, false, err
	}
	unlock := func() error {
		// EOF releases a prepared lock before Wait returns. Never kill Git as
		// the normal cancellation path: SIGKILL could strand its lock file.
		stdin.Close()
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("State lock: %s (%w)", strings.TrimSpace(stderr.buffer.String()), err)
		}
		return nil
	}
	ready := make(chan error, 1)
	go func() {
		_, err := fmt.Fprintf(stdin, "start\nverify refs/worktree/%s-state-lock\nprepare\n", name)
		if err == nil {
			scanner := bufio.NewScanner(io.LimitReader(stdout, 1024))
			for _, expected := range []string{"start: ok", "prepare: ok"} {
				if !scanner.Scan() || scanner.Text() != expected {
					err = fmt.Errorf("Git did not prepare the state transaction")
					break
				}
			}
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err == nil {
			return unlock, false, nil
		}
		failure := unlock()
		busy := strings.Contains(stderr.buffer.String(), "File exists") || strings.Contains(stderr.buffer.String(), "another git process")
		if failure == nil {
			failure = err
		}
		return nil, busy, failure
	case <-ctx.Done():
		stdin.Close()
		<-ready
		_ = cmd.Wait()
		return nil, false, ctx.Err()
	}
}
