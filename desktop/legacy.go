package main

import (
	"bytes"
	"debug/buildinfo"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// legacyDaemon is where the browser CLI of ghl 0.1 and 0.2 kept its shared server.
const legacyDaemon = "http://127.0.0.1:7777"

// legacyCLI is the main package of that CLI, as its build info records it.
const legacyCLI = "github.com/vmaerten/ghl/cmd/ghl"

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

// removeSourceCLI removes what `task install` left in ~/.local/bin before 0.3: a
// copy of the Go CLI, or a link to the Node copy in ~/.local/share/ghl. Either
// would shadow the app's ghl on PATH. Anything else there stays.
func removeSourceCLI(home string) {
	bin := filepath.Join(home, ".local", "bin", "ghl")
	nodeCopy := filepath.Join(home, ".local", "share", "ghl")
	if info, err := os.Lstat(bin); err == nil && info.Mode().IsRegular() {
		if build, err := buildinfo.ReadFile(bin); err == nil && build.Path == legacyCLI {
			os.Remove(bin)
		}
	} else if target, err := os.Readlink(bin); err == nil && target == filepath.Join(nodeCopy, "bin", "ghl.ts") {
		os.Remove(bin)
	}
	if _, err := os.Stat(filepath.Join(nodeCopy, "INSTALLED")); err == nil {
		os.RemoveAll(nodeCopy)
	}
}
