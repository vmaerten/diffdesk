package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Hash the actual executable, including embedded assets. Direct go builds and
// two builds at the same Git commit can still have different runtime contents.
func runtimeRevision() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

// Kernel locks serialize launch/upgrade/registration across unrelated repos.
// No PID file or stale-lock cleanup: closing the descriptor releases the lock.
func startupLock(ctx context.Context, port int) (func(), error) {
	if port == 0 {
		return func() {}, nil
	}
	directory := filepath.Join(os.TempDir(), fmt.Sprintf("ghl-go-runtime-%d", os.Getuid()))
	if err := os.Mkdir(directory, 0700); err != nil && !os.IsExist(err) {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return nil, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || int(stat.Uid) != os.Getuid() {
		return nil, fmt.Errorf("Unsafe runtime lock directory: %s", directory)
	}
	file, err := os.OpenFile(filepath.Join(directory, strconv.Itoa(port)+".lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("Unsafe runtime lock file")
	}
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { file.Close() }, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			file.Close()
			return nil, err
		}
		select {
		case <-wait.Done():
			file.Close()
			return nil, fmt.Errorf("Runtime startup is busy: %w", wait.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// Probes and control requests bypass proxies: only the selected loopback port
// may answer. Redirects are refused before any lifecycle action is considered.
func runtimeRequest(ctx context.Context, port int, method, path string, body any, result any) error {
	var reader io.Reader
	if body != nil {
		bytes, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(bytes))
	}
	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 3 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		bytes, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(bytes)))
	}
	return json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(result)
}

func probeRuntime(ctx context.Context, port int) (*runtimeHealth, error) {
	probe, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	var health runtimeHealth
	if err := runtimeRequest(probe, port, "GET", "/api/health", nil, &health); err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return nil, nil
		}
		return nil, fmt.Errorf("Port %d is occupied or cannot be probed (%w); choose --port or GHL_PORT", port, err)
	}
	if !health.Go || health.PoC || health.Runtime != "go" || health.ProtocolVersion != buildInfo().ProtocolVersion || len(health.Instance) != 32 || len(health.Revision) != 64 || health.PID <= 0 {
		return nil, fmt.Errorf("Port %d serves an incompatible runtime; it was left running. Choose --port or GHL_PORT", port)
	}
	if !health.Daemon {
		return nil, fmt.Errorf("Port %d serves a foreground runtime; it was left running. Choose --port or GHL_PORT", port)
	}
	return &health, nil
}

func waitPortClosed(ctx context.Context, port int) error {
	wait, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	for {
		conn, err := (&net.Dialer{Timeout: 200 * time.Millisecond}).DialContext(wait, "tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if errors.Is(err, syscall.ECONNREFUSED) {
			return nil
		}
		if conn != nil {
			conn.Close()
		}
		select {
		case <-wait.Done():
			return fmt.Errorf("Runtime did not release port %d: %w", port, wait.Err())
		case <-time.After(25 * time.Millisecond):
		}
	}
}

func spawnDaemon(ctx context.Context, cli commandArgs) (int, error) {
	executable, err := os.Executable()
	if err != nil {
		return 0, err
	}
	read, write, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	defer read.Close()
	defer write.Close()
	log, err := os.CreateTemp("", "ghl-go-startup-*.log")
	if err != nil {
		return 0, err
	}
	defer os.Remove(log.Name())
	defer log.Close()
	cmd := exec.Command(executable, "--daemon", "--port", strconv.Itoa(cli.port), "--idle", strconv.FormatFloat(cli.idle.Minutes(), 'g', -1, 64))
	cmd.Stdout, cmd.Stderr = write, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	write.Close()
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	ready := make(chan struct {
		port int
		err  error
	}, 1)
	go func() {
		var announcement struct {
			Port int `json:"port"`
		}
		err := json.NewDecoder(io.LimitReader(read, 4096)).Decode(&announcement)
		ready <- struct {
			port int
			err  error
		}{announcement.Port, err}
	}()
	timeout, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	select {
	case result := <-ready:
		if result.err == nil && result.port > 0 && result.port <= 65535 {
			return result.port, nil
		}
		_ = cmd.Process.Kill() // Only our own failed child, never a probed listener.
		<-exited
		bytes, _ := os.ReadFile(log.Name())
		return 0, fmt.Errorf("Daemon startup failed: %s (%v)", strings.TrimSpace(string(bytes)), result.err)
	case <-timeout.Done():
		_ = cmd.Process.Kill()
		<-exited
		return 0, fmt.Errorf("Daemon startup timed out: %w", timeout.Err())
	}
}

func useDaemon(ctx context.Context, cli commandArgs, repo Repository, revision string, stderr io.Writer) (int, error) {
	unlock, err := startupLock(ctx, cli.port)
	if err != nil {
		return 0, err
	}
	defer unlock()
	var inherited []registeredRepo
	port := cli.port
	if port != 0 {
		health, err := probeRuntime(ctx, port)
		if err != nil {
			return 0, err
		}
		if health != nil && health.Revision != revision {
			var handoff struct {
				Repos []registeredRepo `json:"repos"`
			}
			if err := runtimeRequest(ctx, port, "POST", "/api/shutdown", map[string]string{"instance": health.Instance}, &handoff); err != nil {
				return 0, fmt.Errorf("Could not replace older runtime: %w", err)
			}
			inherited = handoff.Repos
			if err := waitPortClosed(ctx, port); err != nil {
				return 0, err
			}
			health = nil
		}
		if health == nil {
			port, err = spawnDaemon(ctx, cli)
			if err != nil {
				return 0, err
			}
		}
	} else {
		port, err = spawnDaemon(ctx, cli)
		if err != nil {
			return 0, err
		}
	}
	// Verify the actual listener, including races with a service outside our lock.
	health, err := probeRuntime(ctx, port)
	if err != nil {
		return 0, err
	}
	if health == nil || health.Revision != revision {
		return 0, fmt.Errorf("The expected Go daemon is no longer listening on port %d; retry", port)
	}
	for _, entry := range inherited {
		var restored registeredRepo
		if err := runtimeRequest(ctx, port, "POST", "/api/repos", map[string]string{"repoPath": entry.Path}, &restored); err != nil {
			fmt.Fprintf(stderr, "ghl: Could not restore repository %s: %v\n", entry.Path, err)
		}
	}
	var registered registeredRepo
	if err := runtimeRequest(ctx, port, "POST", "/api/repos", map[string]string{"repoPath": repo.Path}, &registered); err != nil {
		return 0, fmt.Errorf("Could not register repository: %w", err)
	}
	if registered.ID != repoID(repo.Path) || registered.Path != repo.Path {
		return 0, fmt.Errorf("Daemon returned a different repository identity")
	}
	return port, nil
}

func displayHost(ctx context.Context) string {
	lookup, cancel := context.WithTimeout(ctx, 300*time.Millisecond)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(lookup, "ip4", "ghl.localhost")
	if err == nil && len(ips) > 0 {
		for _, ip := range ips {
			if !ip.Equal(net.IPv4(127, 0, 0, 1)) {
				return "127.0.0.1"
			}
		}
		return "ghl.localhost"
	}
	return "127.0.0.1"
}
