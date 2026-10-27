package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const latestReleaseURL = "https://api.github.com/repos/vmaerten/ghl/releases/latest"

var stableVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

func stableVersion(value string) ([3]uint64, bool) {
	var version [3]uint64
	if !stableVersionPattern.MatchString(value) {
		return version, false
	}
	for i, part := range strings.Split(value, ".") {
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return version, false
		}
		version[i] = n
	}
	return version, true
}

func newerVersion(candidate, current string) bool {
	a, okA := stableVersion(candidate)
	b, okB := stableVersion(current)
	if !okA || !okB {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

type updateRelease struct {
	Version string
	Notes   string
}

// latestUpdate returns only a newer stable release with this platform's archive.
// The endpoint is fixed in production; tests use a local HTTP server.
func latestUpdate(ctx context.Context, client *http.Client, endpoint, current string) (updateRelease, error) {
	if _, ok := stableVersion(current); !ok {
		return updateRelease{}, fmt.Errorf("automatic updates are available for stable release builds")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return updateRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Diffdesk/"+current)
	response, err := client.Do(req)
	if err != nil {
		return updateRelease{}, fmt.Errorf("check GitHub Releases: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return updateRelease{}, nil // No stable release published yet.
	}
	if response.StatusCode != http.StatusOK {
		return updateRelease{}, fmt.Errorf("check GitHub Releases: HTTP %d; please try again later", response.StatusCode)
	}
	const limit = 1 << 20
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return updateRelease{}, err
	}
	if len(raw) > limit {
		return updateRelease{}, fmt.Errorf("GitHub release response is too large")
	}
	var release struct {
		Body       string                  `json:"body"`
		Tag        string                  `json:"tag_name"`
		Draft      bool                    `json:"draft"`
		Prerelease bool                    `json:"prerelease"`
		Assets     []struct{ Name string } `json:"assets"`
	}
	if err := json.Unmarshal(raw, &release); err != nil {
		return updateRelease{}, fmt.Errorf("read GitHub release: %w", err)
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if release.Draft || release.Prerelease || !newerVersion(version, current) {
		return updateRelease{}, nil
	}
	for _, asset := range release.Assets {
		if asset.Name == "diffdesk_"+version+"_darwin_arm64.zip" {
			return updateRelease{Version: version, Notes: strings.TrimSpace(release.Body)}, nil
		}
	}
	return updateRelease{}, fmt.Errorf("release %s has no macOS Apple Silicon archive yet; please try again later", version)
}

// Commands run directly, with no shell, outside any checkout. Keep output
// bounded: a package manager may otherwise retain an entire download log.
type updateRunner func(context.Context, string, ...string) ([]byte, error)

type updateOutput struct{ data []byte }

func (o *updateOutput) Write(p []byte) (int, error) {
	n := len(p)
	o.data = append(o.data, p...)
	if len(o.data) > 32*1024 {
		o.data = o.data[len(o.data)-32*1024:]
	}
	return n, nil
}

func runUpdateCommand(ctx context.Context, executable string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Dir = "/"
	cmd.WaitDelay = 2 * time.Second
	// A Finder launch has a minimal PATH. Package managers need their own
	// executables on PATH too, and neither needs an interactive sudo prompt.
	cmd.Env = append(os.Environ(), "PATH="+os.Getenv("PATH")+":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "SUDO_ASKPASS=/usr/bin/false")
	var stdout, stderr updateOutput
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%s %s: %w\n%s%s", filepath.Base(executable), strings.Join(args, " "), err, stdout.data, stderr.data)
	}
	return stdout.data, nil
}

type updateInstallation struct {
	manager string
	command string
	bundle  string
}

func samePath(a, b string) bool {
	resolvedA, errA := filepath.EvalSymlinks(a)
	resolvedB, errB := filepath.EvalSymlinks(b)
	return errA == nil && errB == nil && resolvedA == resolvedB
}

func findUpdateCommand(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	home, _ := os.UserHomeDir()
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin", filepath.Join(home, ".local", "bin")} {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path
		}
	}
	return ""
}

// Identify the owner of this exact bundle, rather than any other installation
// of Diffdesk on the machine. A source build must never upgrade a user's cask.
func detectUpdateInstallation(ctx context.Context, bundle, current, brew, mise string, run updateRunner) (updateInstallation, error) {
	if brew != "" {
		if raw, err := run(ctx, brew, "--caskroom"); err == nil {
			root := strings.TrimSpace(string(raw))
			if filepath.IsAbs(root) && samePath(filepath.Join(root, "diffdesk", current, "Diffdesk.app"), bundle) {
				return updateInstallation{"Homebrew", brew, bundle}, nil
			}
		}
	}
	if mise != "" {
		if raw, err := run(ctx, mise, "where", "github:vmaerten/ghl@"+current); err == nil {
			root := strings.TrimSpace(string(raw))
			if filepath.IsAbs(root) && samePath(filepath.Join(root, "Diffdesk.app"), bundle) {
				return updateInstallation{"mise", mise, bundle}, nil
			}
		}
	}
	return updateInstallation{}, fmt.Errorf("this copy of Diffdesk is not managed by Homebrew or mise. Install with brew install --cask vmaerten/tap/diffdesk or mise use -g github:vmaerten/ghl@latest to enable in-app updates")
}

func (installation updateInstallation) install(ctx context.Context, offered string, run updateRunner) (string, error) {
	if _, ok := stableVersion(offered); !ok {
		return "", fmt.Errorf("invalid update version")
	}
	bundle := installation.bundle
	switch installation.manager {
	case "Homebrew":
		if _, err := run(ctx, installation.command, "update"); err != nil {
			return "", err
		}
		if _, err := run(ctx, installation.command, "upgrade", "--cask", "vmaerten/tap/diffdesk"); err != nil {
			return "", err
		}
	case "mise":
		// use --global works with the pinned mise 2026.10.2 acceptance CLI;
		// upgrade --global requires a newer mise. use keeps the running install,
		// and --fuzzy saves latest even when the user enables version pinning.
		// https://mise.jdx.dev/cli/use.html
		if _, err := run(ctx, installation.command, "use", "--global", "--fuzzy", "--minimum-release-age", "0s", "--yes", "github:vmaerten/ghl@latest"); err != nil {
			return "", err
		}
		raw, err := run(ctx, installation.command, "where", "github:vmaerten/ghl@latest")
		if err != nil {
			return "", err
		}
		root := strings.TrimSpace(string(raw))
		if !filepath.IsAbs(root) {
			return "", fmt.Errorf("mise returned an invalid installation path")
		}
		bundle = filepath.Join(root, "Diffdesk.app")
	default:
		return "", fmt.Errorf("unsupported update manager")
	}
	// The cask can lag behind a GitHub release. Never quit the working app or
	// claim success until the installed executable reports the offered version.
	raw, err := run(ctx, filepath.Join(bundle, "Contents", "MacOS", "diffdesk"), "--version", "--json")
	if err != nil {
		return "", err
	}
	var info struct{ Version string }
	if json.Unmarshal(raw, &info) != nil || (info.Version != offered && !newerVersion(info.Version, offered)) {
		return "", fmt.Errorf("%s has not installed Diffdesk %s yet; please try again later", installation.manager, offered)
	}
	return bundle, nil
}
