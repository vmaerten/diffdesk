package main

import (
	"context"
	"embed"
	"io/fs"
	"os"
	"os/signal"
	"syscall"

	"github.com/vmaerten/ghl/internal/app"
)

//go:embed all:assets
var embedded embed.FS

func main() {
	assets, err := fs.Sub(embedded, "assets")
	if err != nil {
		panic(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := app.Main(ctx, os.Args[1:], os.Stdout, os.Stderr, app.Options{Assets: assets, PoC: true})
	cancel()
	os.Exit(code)
}
