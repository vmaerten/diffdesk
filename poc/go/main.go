package main

import (
	"context"
	"crypto/sha1"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

// The placeholder makes backend tests possible before the frontend is built.
//
//go:embed all:assets
var embedded embed.FS

func repoID(path string) string {
	hash := fmt.Sprintf("%x", sha1.Sum([]byte(path)))
	return filepath.Base(path) + "-" + hash[:7]
}

func run() error {
	repoPath := flag.String("repo", ".", "Repository path")
	base := flag.String("base", "HEAD", "Explicit base ref (comparison starts at its merge-base with HEAD)")
	port := flag.Int("port", 0, "Loopback port, 0 chooses an ephemeral port")
	noOpen := flag.Bool("no-open", false, "Do not open the browser")
	announceJSON := flag.Bool("json", false, "Announce {port, repoId, url} on stdout")
	flag.Parse()
	if flag.NArg() != 0 || *port < 0 || *port > 65535 {
		return fmt.Errorf("Invalid arguments; use --help")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	repo, err := openRepository(ctx, *repoPath)
	if err != nil {
		return err
	}
	if _, err = repo.Compare(ctx, *base, false); err != nil {
		return err
	}
	assets, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	if _, err := fs.Stat(assets, "index.html"); err != nil {
		return fmt.Errorf("UI not built: run pnpm poc:go:build")
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	id := repoID(repo.Path)
	actualPort := listener.Addr().(*net.TCPAddr).Port
	address := fmt.Sprintf("http://127.0.0.1:%d/r/%s?base=%s", actualPort, url.PathEscape(id), url.QueryEscape(*base))
	app := &Server{repo: repo, id: id, base: *base, assets: assets, store: &Store{path: filepath.Join(repo.GitDir, "ghl-go-poc", "state.json")}}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	if *announceJSON {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"port": actualPort, "repoId": id, "url": address})
	} else {
		fmt.Println(address)
	}
	if runtime.GOOS == "darwin" && !*noOpen {
		if err := exec.CommandContext(ctx, "open", address).Run(); err != nil {
			fmt.Fprintln(os.Stderr, "Could not open browser:", err)
		}
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return err
		}
		return nil
	case err := <-done:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ghl-go-poc:", err)
		os.Exit(1)
	}
}
