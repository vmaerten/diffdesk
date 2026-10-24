package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// legacyDaemon is where the browser CLI of ghl 0.1 and 0.2 kept its shared server.
const legacyDaemon = "http://127.0.0.1:7777"

// stopLegacyDaemon stops a daemon left running by ghl 0.1 or 0.2 and removes its
// lock folder. Its reviews stay in each repository's state. Best effort.
func stopLegacyDaemon(base, tempDir string) {
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	var health struct {
		Go       bool   `json:"ghlGo"`
		Daemon   bool   `json:"daemon"`
		Instance string `json:"instance"`
	}
	if response, err := client.Get(base + "/api/health"); err == nil {
		err = json.NewDecoder(response.Body).Decode(&health)
		response.Body.Close()
		// The instance stops this daemon only, not one that replaced it meanwhile.
		if err == nil && health.Go && health.Daemon && health.Instance != "" {
			body, _ := json.Marshal(map[string]string{"instance": health.Instance})
			if response, err := client.Post(base+"/api/shutdown", "application/json", bytes.NewReader(body)); err == nil {
				response.Body.Close()
			}
		}
	}
	os.RemoveAll(filepath.Join(tempDir, fmt.Sprintf("ghl-go-runtime-%d", os.Getuid())))
}
