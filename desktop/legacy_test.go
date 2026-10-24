package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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
