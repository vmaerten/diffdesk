package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestStopLegacyDaemon(t *testing.T) {
	for _, daemon := range []bool{true, false} {
		stopped := make(chan string, 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/health":
				json.NewEncoder(w).Encode(map[string]any{"ghlGo": true, "daemon": daemon, "instance": "0.2.0"})
			case "/api/shutdown":
				var body struct {
					Instance string `json:"instance"`
				}
				json.NewDecoder(r.Body).Decode(&body)
				stopped <- body.Instance
				w.Write([]byte(`{"ok":true}`))
			}
		}))
		dir := t.TempDir()
		locks := filepath.Join(dir, fmt.Sprintf("ghl-go-runtime-%d", os.Getuid()))
		if err := os.Mkdir(locks, 0o700); err != nil {
			t.Fatal(err)
		}
		stopLegacyDaemon(server.URL, dir)
		server.Close()
		got := ""
		select {
		case got = <-stopped:
		default:
		}
		// A server that is not the old daemon, such as the app's own, keeps running.
		if want := map[bool]string{true: "0.2.0"}[daemon]; got != want {
			t.Errorf("daemon %v: shutdown for %q, want %q", daemon, got, want)
		}
		if _, err := os.Stat(locks); !os.IsNotExist(err) {
			t.Errorf("daemon %v: lock folder kept: %v", daemon, err)
		}
	}
}

func TestRemoveSourceCLI(t *testing.T) {
	// A binary whose build info names the 0.2 CLI's main package.
	module := t.TempDir()
	os.MkdirAll(filepath.Join(module, "cmd", "ghl"), 0o755)
	os.WriteFile(filepath.Join(module, "go.mod"), []byte("module github.com/vmaerten/ghl\n\ngo 1.25\n"), 0o644)
	os.WriteFile(filepath.Join(module, "cmd", "ghl", "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644)
	cli := filepath.Join(t.TempDir(), "ghl")
	build := exec.Command("go", "build", "-o", cli, "./cmd/ghl")
	build.Dir = module
	build.Env = append(os.Environ(), "GOWORK=off", "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	install := func(home string, contents []byte) string {
		bin := filepath.Join(home, ".local", "bin", "ghl")
		os.MkdirAll(filepath.Dir(bin), 0o755)
		if err := os.WriteFile(bin, contents, 0o755); err != nil {
			t.Fatal(err)
		}
		return bin
	}
	binary, err := os.ReadFile(cli)
	if err != nil {
		t.Fatal(err)
	}
	old := t.TempDir()
	copied := install(old, binary)
	removeSourceCLI(old)
	if _, err := os.Lstat(copied); !os.IsNotExist(err) {
		t.Errorf("Go CLI kept: %v", err)
	}

	// The Node install: a copy marked INSTALLED and a link to its entry point.
	node := t.TempDir()
	nodeCopy := filepath.Join(node, ".local", "share", "ghl")
	os.MkdirAll(filepath.Join(nodeCopy, "bin"), 0o755)
	os.WriteFile(filepath.Join(nodeCopy, "INSTALLED"), []byte("abc from /src\n"), 0o644)
	bin := filepath.Join(node, ".local", "bin", "ghl")
	os.MkdirAll(filepath.Dir(bin), 0o755)
	os.Symlink(filepath.Join(nodeCopy, "bin", "ghl.ts"), bin)
	removeSourceCLI(node)
	if _, err := os.Lstat(bin); !os.IsNotExist(err) {
		t.Errorf("Node link kept: %v", err)
	}
	if _, err := os.Stat(nodeCopy); !os.IsNotExist(err) {
		t.Errorf("Node copy kept: %v", err)
	}

	// Another program called ghl stays.
	other := t.TempDir()
	foreign := install(other, []byte("#!/bin/sh\n"))
	removeSourceCLI(other)
	if _, err := os.Stat(foreign); err != nil {
		t.Errorf("unrelated ghl removed: %v", err)
	}
}
