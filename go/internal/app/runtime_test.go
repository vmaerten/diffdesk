package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func TestRuntimeRegistryAndConditionalShutdown(t *testing.T) {
	repo := fixture(t)
	server, err := newRuntime(Options{Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("embedded")}}}, strings.Repeat("a", 64), true)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body, host, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		if host != "" {
			req.Host = host
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		result := httptest.NewRecorder()
		server.ServeHTTP(result, req)
		return result
	}
	payload, _ := json.Marshal(map[string]string{"repoPath": filepath.Join(repo.Path, "..", filepath.Base(repo.Path))})
	var wg sync.WaitGroup
	replies := make(chan *httptest.ResponseRecorder, 12)
	for range 12 {
		wg.Add(1)
		go func() { defer wg.Done(); replies <- request("POST", "/api/repos", string(payload), "", "") }()
	}
	wg.Wait()
	close(replies)
	for reply := range replies {
		requireStatus(t, reply, 200)
	}
	health := request("GET", "/api/health", "", "", "")
	var data runtimeHealth
	if err := json.Unmarshal(health.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Repos) != 1 || data.Repos[0].ID != repoID(repo.Path) || !data.Daemon {
		t.Fatalf("registry lost identity: %s", health.Body.String())
	}
	requireStatus(t, request("GET", "/r/"+data.Repos[0].ID, "", "", ""), 200)
	requireStatus(t, request("POST", "/api/repos", `{"repoPath":"relative"}`, "", ""), 400)
	requireStatus(t, request("POST", "/api/repos", `{"repoPath":"/missing"}`, "", ""), 422)
	requireStatus(t, request("GET", "/api/repos", "", "attacker.invalid", ""), 403)
	requireStatus(t, request("POST", "/api/shutdown", `{}`, "", "https://attacker.invalid"), 403)
	requireStatus(t, request("POST", "/api/shutdown", `{"instance":"stale"}`, "", ""), 409)
	body, _ := json.Marshal(map[string]string{"instance": data.Instance})
	stopped := request("POST", "/api/shutdown", string(body), "", "")
	requireStatus(t, stopped, 200)
	var handoff struct {
		Repos []registeredRepo `json:"repos"`
	}
	if err := json.Unmarshal(stopped.Body.Bytes(), &handoff); err != nil || len(handoff.Repos) != 1 {
		t.Fatalf("handoff lost repos: %s", stopped.Body.String())
	}
	requireStatus(t, request("POST", "/api/repos", string(payload), "", ""), 503)
	select {
	case <-server.stopped:
	default:
		t.Fatal("shutdown did not signal lifecycle")
	}
}

func TestRuntimeHeartbeatAndRejectedRequestsDoNotDelayIdle(t *testing.T) {
	server, err := newRuntime(Options{}, strings.Repeat("a", 64), true)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	before := time.Now()
	server.mu.Lock()
	server.lastSeen = before.Add(-time.Second)
	server.mu.Unlock()
	heartbeat := httptest.NewRecorder()
	server.ServeHTTP(heartbeat, httptest.NewRequest("POST", "http://localhost/api/heartbeat", nil))
	requireStatus(t, heartbeat, 200)
	server.mu.Lock()
	recent := !server.lastSeen.Before(before)
	server.mu.Unlock()
	if !recent {
		t.Fatal("heartbeat did not update last activity")
	}
	// Force the last valid activity into the past rather than rely on scheduler timing.
	server.mu.Lock()
	server.lastSeen = time.Now().Add(-time.Second)
	server.mu.Unlock()
	rejected := httptest.NewRecorder()
	server.ServeHTTP(rejected, httptest.NewRequest("GET", "http://attacker.invalid/api/health", nil))
	requireStatus(t, rejected, 403)
	go server.watchIdle(ctx, 20*time.Millisecond)
	select {
	case <-server.stopped:
	case <-time.After(time.Second):
		t.Fatal("rejected request kept daemon alive")
	}
}

func TestStartupLockCancellationAndRelease(t *testing.T) {
	// Use a real ephemeral port to avoid interference with lifecycle tests.
	listener, _, err := listenRuntime(0, Options{}, "test", false)
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	unlock, err := startupLock(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { unlock() }()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if release, err := startupLock(ctx, port); err == nil {
		release()
		t.Fatal("concurrent launch bypassed lock")
	}
	unlock()
	unlock, err = startupLock(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
}
