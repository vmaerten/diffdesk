package app

import (
	"context"
	"os/exec"
	"runtime"
)

// Invoke the desktop's URL handler directly: the URL is a single argument,
// including any comparison parameters, and never passes through a shell.
func openBrowser(ctx context.Context, address string) error {
	var command string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
	case "linux":
		command = "xdg-open"
	default:
		return nil
	}
	return exec.CommandContext(ctx, command, address).Run()
}
