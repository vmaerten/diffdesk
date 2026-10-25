package app

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const environmentMarker = "__GHL_ENVIRONMENT__"

// loginEnvironment asks the user's shell for the environment a terminal opened
// in root would have. Launched from the Finder, ghl inherits launchd's PATH,
// without Homebrew, mise or ~/go/bin, and gopls also needs go on it.
func loginEnvironment(shell, root string, timeout time.Duration) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	// The startup files may print anything: the environment follows the marker.
	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "printf "+environmentMarker+"; /usr/bin/env -0")
	cmd.Dir, cmd.Env = root, os.Environ()
	// A startup file that hangs, or leaves a child holding the output, must not
	// hold the server back.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	_, listing, found := bytes.Cut(output, []byte(environmentMarker))
	if !found {
		return nil, errors.New("the shell printed no environment")
	}
	var env []string
	for _, entry := range strings.Split(string(listing), "\x00") {
		if strings.Contains(entry, "=") {
			env = append(env, entry)
		}
	}
	if environmentValue(env, "PATH") == "" {
		return nil, errors.New("the shell printed no PATH")
	}
	return env, nil
}

// serverEnvironment is the login shell's environment, or this process's with
// the usual install directories added when the shell cannot tell.
func serverEnvironment(root string) []string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/zsh"
	}
	if env, err := loginEnvironment(shell, root, 5*time.Second); err == nil {
		return env
	}
	home, _ := os.UserHomeDir()
	dirs := []string{os.Getenv("PATH"), "/opt/homebrew/bin", "/usr/local/bin"}
	if home != "" {
		dirs = append(dirs, filepath.Join(home, "go", "bin"), filepath.Join(home, ".cargo", "bin"), filepath.Join(home, ".local", "bin"))
	}
	return append(os.Environ(), "PATH="+strings.Join(dirs, string(filepath.ListSeparator)))
}
