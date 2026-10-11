package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/vmaerten/ghl/internal/app"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// Vite serves the live frontend; no generated embedded UI is needed in dev.
	// Environment values preserve paths with spaces through Air's shell runner.
	args := []string{
		"--repo", os.Getenv("GHL_DEV_REPO"),
		"--base", os.Getenv("GHL_DEV_BASE"),
		"--port", os.Getenv("GHL_DEV_BACKEND_PORT"),
		"--no-open", "--no-daemon", "--json",
	}
	code := app.Main(ctx, args, os.Stdout, os.Stderr, app.Options{Assets: os.DirFS("../web")})
	cancel()
	os.Exit(code)
}
