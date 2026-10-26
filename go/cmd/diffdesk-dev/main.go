// The review server without the desktop window: `task dev` and the tests.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"github.com/vmaerten/diffdesk/internal/app"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "diffdesk-dev:", err)
		os.Exit(1)
	}
}

func run() error {
	// Environment defaults preserve paths with spaces through Air's shell runner.
	repo := flag.String("repo", env("DIFFDESK_DEV_REPO", "."), "repository to register")
	base := flag.String("base", os.Getenv("DIFFDESK_DEV_BASE"), "base ref carried by the announced URL")
	port := flag.String("port", env("DIFFDESK_DEV_BACKEND_PORT", "0"), "loopback port, 0 for an ephemeral one")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", *port))
	if err != nil {
		return err
	}
	defer listener.Close()
	// Vite serves the live frontend, and the tests the built one: no UI here.
	runtime := app.NewRuntime(nil)
	entry, err := runtime.Open(ctx, *repo)
	if err != nil {
		return err
	}
	actual := listener.Addr().(*net.TCPAddr).Port
	address := fmt.Sprintf("http://127.0.0.1:%d/r/%s", actual, url.PathEscape(entry.ID))
	if *base != "" {
		address += "?" + url.Values{"base": {*base}}.Encode()
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"port": actual, "repoId": entry.ID, "url": address}); err != nil {
		return err
	}
	return runtime.Serve(ctx, listener)
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
