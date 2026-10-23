package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// One app runs per user and instance ID. It holds a lock file and listens on a
// Unix socket beside it; launchers hand it review requests over that socket and
// wait until it has queued them. Wails' own single-instance lock is taken early
// but listens only once the app has finished launching, and a request sent in
// between was dropped without an error.
type instance struct {
	lock     *os.File
	listener net.Listener
	socket   string
}

type delivery struct {
	Args []string `json:"args"`
}

type receipt struct {
	Error string `json:"error,omitempty"`
}

// errNoApp means no app listens yet: start one, then deliver again.
var errNoApp = errors.New("no ghl app is running")

// instancePaths stays short: macOS limits a Unix socket path to 104 bytes.
func instancePaths(dir, id string) (lock, socket string) {
	base := filepath.Join(dir, fmt.Sprintf("ghl-%x", sha256.Sum256([]byte(id)))[:16])
	return base + ".lock", base + ".sock"
}

// claimInstance makes this process the app for id, or reports that another one is.
func claimInstance(dir, id string) (*instance, error) {
	lockPath, socketPath := instancePaths(dir, id)
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, nil
		}
		return nil, err
	}
	// Holding the lock proves no app listens: a socket left by a crash is stale.
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		lock.Close()
		return nil, err
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		lock.Close()
		return nil, err
	}
	return &instance{lock: lock, listener: listener, socket: socketPath}, nil
}

// serve answers each delivery with accept's verdict, until close.
func (i *instance) serve(accept func(launch) error) {
	for {
		conn, err := i.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
			var message delivery
			var reply receipt
			if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&message); err != nil {
				reply.Error = "unreadable request"
			} else if request, err := parseLaunch(message.Args, "/"); err != nil {
				// Launchers send canonical arguments; anything else is untrusted input.
				reply.Error = err.Error()
			} else if err := accept(request); err != nil {
				reply.Error = err.Error()
			}
			_ = json.NewEncoder(conn).Encode(reply)
		}()
	}
}

func (i *instance) close() {
	i.listener.Close()
	os.Remove(i.socket)
	i.lock.Close()
}

// deliver hands request to the app and waits until it is queued. It retries
// for up to wait while the app starts, and returns errNoApp if none answers.
func deliver(dir, id string, request launch, wait time.Duration) error {
	_, socketPath := instancePaths(dir, id)
	deadline := time.Now().Add(wait)
	for {
		conn, err := net.DialTimeout("unix", socketPath, time.Second)
		if err == nil {
			return send(conn, request)
		}
		if time.Now().After(deadline) {
			return errNoApp
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func send(conn net.Conn, request launch) error {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	if err := json.NewEncoder(conn).Encode(delivery{Args: request.arguments()}); err != nil {
		return fmt.Errorf("could not reach the ghl app: %w", err)
	}
	var reply receipt
	if err := json.NewDecoder(conn).Decode(&reply); err != nil {
		return fmt.Errorf("the ghl app did not confirm the review: %w", err)
	}
	if reply.Error != "" {
		return errors.New(reply.Error)
	}
	return nil
}
