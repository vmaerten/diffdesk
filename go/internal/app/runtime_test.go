package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

func TestRuntimeRegistryAndHealth(t *testing.T) {
	repo := fixture(t)
	server := NewRuntime(fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("embedded")}})
	request := func(method, path, body, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
		if host != "" {
			req.Host = host
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
		go func() { defer wg.Done(); replies <- request("POST", "/api/repos", string(payload), "") }()
	}
	wg.Wait()
	close(replies)
	for reply := range replies {
		requireStatus(t, reply, 200)
	}
	health := request("GET", "/api/health", "", "")
	var data runtimeHealth
	if err := json.Unmarshal(health.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if data.BuildInfo != buildInfo() || data.PID <= 0 || len(data.Repos) != 1 || data.Repos[0].ID != repoID(repo.Path) {
		t.Fatalf("registry lost identity: %s", health.Body.String())
	}
	requireStatus(t, request("GET", "/r/"+data.Repos[0].ID, "", ""), 200)
	requireStatus(t, request("POST", "/api/repos", `{"repoPath":"relative"}`, ""), 400)
	requireStatus(t, request("POST", "/api/repos", `{"repoPath":"/missing"}`, ""), 422)
	requireStatus(t, request("GET", "/api/repos", "", "attacker.invalid"), 403)
}

func TestRuntimeWithoutAssetsServesTheAPIOnly(t *testing.T) {
	server := NewRuntime(nil)
	entry, err := server.Open(context.Background(), fixture(t).Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/r/" + entry.ID} {
		w := httptest.NewRecorder()
		server.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost"+path, nil))
		requireStatus(t, w, 404)
	}
	w := httptest.NewRecorder()
	server.ServeHTTP(w, httptest.NewRequest("GET", "http://localhost/r/"+entry.ID+"/api/diff?base=main", nil))
	requireStatus(t, w, 200)
}

func TestRuntimeServeStopsWithItsContext(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- NewRuntime(nil).Serve(ctx, listener) }()
	response, err := http.Get("http://" + listener.Addr().String() + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("Serve outlived its context")
	}
}
