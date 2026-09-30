package app

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// Set by the build; direct `go build` remains usable for development.
var version = "dev"
var commit = "unknown"
var buildDate = "unknown"

type BuildInfo struct {
	Version         string `json:"version"`
	Commit          string `json:"commit"`
	BuildDate       string `json:"buildDate"`
	Runtime         string `json:"runtime"`
	ProtocolVersion int    `json:"protocolVersion"`
}

func buildInfo() BuildInfo {
	return BuildInfo{version, commit, buildDate, "go", 1}
}

type Options struct {
	Assets fs.FS
	PoC    bool
}

func (o Options) name() string {
	if o.PoC {
		return "ghl-go-poc"
	}
	return "ghl"
}

func (o Options) statePath(gitDir string) string {
	directory := "ghl-go"
	if o.PoC {
		directory = "ghl-go-poc"
	}
	return filepath.Join(gitDir, directory, "state.json")
}

func repoID(path string) string {
	hash := fmt.Sprintf("%x", sha1.Sum([]byte(path)))
	return filepath.Base(path) + "-" + hash[:7]
}

// Main is shared by the production and isolated PoC entry points.
func Main(ctx context.Context, args []string, stdout, stderr io.Writer, options Options) int {
	err := run(ctx, args, stdout, stderr, options)
	if err == nil || errors.Is(err, flag.ErrHelp) {
		return 0
	}
	fmt.Fprintln(stderr, options.name()+":", err)
	return 1
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer, options Options) error {
	flags := flag.NewFlagSet(options.name(), flag.ContinueOnError)
	flags.SetOutput(stderr)
	repoPath := flags.String("repo", ".", "Repository path")
	base := flags.String("base", "HEAD", "Explicit base ref (comparison starts at its merge-base with HEAD)")
	port := flags.Int("port", 0, "Loopback port, 0 chooses an ephemeral port")
	noOpen := flags.Bool("no-open", false, "Do not open the browser")
	announceJSON := flags.Bool("json", false, "Announce {port, repoId, url}, or build metadata with --version")
	showVersion := flags.Bool("version", false, "Print version and build metadata without starting a server")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *port < 0 || *port > 65535 {
		return fmt.Errorf("Invalid arguments; use --help")
	}
	if *showVersion {
		info := buildInfo()
		if *announceJSON {
			return json.NewEncoder(stdout).Encode(info)
		}
		_, err := fmt.Fprintf(stdout, "%s %s (commit %s; built %s)\n", options.name(), info.Version, info.Commit, info.BuildDate)
		return err
	}
	repo, err := openRepository(ctx, *repoPath)
	if err != nil {
		return err
	}
	if _, err = repo.Compare(ctx, *base, false); err != nil {
		return err
	}
	if options.Assets == nil {
		return fmt.Errorf("UI not built")
	}
	if _, err := fs.Stat(options.Assets, "index.html"); err != nil {
		build := "go:build"
		if options.PoC {
			build = "poc:go:build"
		}
		return fmt.Errorf("UI not built: run pnpm %s", build)
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	id := repoID(repo.Path)
	actualPort := listener.Addr().(*net.TCPAddr).Port
	address := fmt.Sprintf("http://127.0.0.1:%d/r/%s?base=%s", actualPort, url.PathEscape(id), url.QueryEscape(*base))
	app := &Server{repo: repo, id: id, base: *base, assets: options.Assets, poc: options.PoC, store: &Store{path: options.statePath(repo.GitDir)}}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	if *announceJSON {
		err = json.NewEncoder(stdout).Encode(map[string]any{"port": actualPort, "repoId": id, "url": address})
	} else {
		_, err = fmt.Fprintln(stdout, address)
	}
	if err != nil {
		listener.Close()
		return err
	}
	if runtime.GOOS == "darwin" && !*noOpen {
		if err := exec.CommandContext(ctx, "open", address).Run(); err != nil {
			fmt.Fprintln(stderr, "Could not open browser:", err)
		}
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		return server.Shutdown(shutdown)
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
