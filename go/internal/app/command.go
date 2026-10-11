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
	cli, err := parseCommand(args, stderr, options)
	if err != nil {
		return err
	}
	if cli.help {
		_, err := io.WriteString(stdout, commandHelp)
		return err
	}
	if cli.version {
		info := buildInfo()
		if cli.json {
			return json.NewEncoder(stdout).Encode(info)
		}
		_, err := fmt.Fprintf(stdout, "%s %s (commit %s; built %s)\n", options.name(), info.Version, info.Commit, info.BuildDate)
		return err
	}
	if _, err := exec.LookPath("git"); err != nil {
		return fmt.Errorf("Git is required: install Git and make git available in PATH (%w)", err)
	}
	repo, err := openRepository(ctx, cli.repo)
	if err != nil {
		return err
	}
	var review *Review
	if options.PoC {
		review, err = repo.Compare(ctx, cli.base, false)
	} else {
		review, err = repo.Resolve(ctx, Selection{Base: cli.base, Target: cli.target, IncludeUntracked: cli.comments})
	}
	if err != nil {
		return err
	}
	if cli.comments {
		return writeComments(ctx, review, &Store{path: options.statePath(repo.GitDir)}, cli.json, stdout, stderr)
	}
	if cli.print {
		return writeSummary(review, cli.target, stdout)
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
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", cli.port))
	if err != nil {
		return err
	}
	id := repoID(repo.Path)
	actualPort := listener.Addr().(*net.TCPAddr).Port
	address := fmt.Sprintf("http://127.0.0.1:%d/r/%s", actualPort, url.PathEscape(id))
	query := url.Values{}
	if cli.base != "" {
		query.Set("base", cli.base)
	}
	if cli.target != "" {
		query.Set("target", cli.target)
	}
	if len(query) > 0 {
		address += "?" + query.Encode()
	}
	app := &Server{repo: repo, id: id, base: cli.base, assets: options.Assets, poc: options.PoC, store: &Store{path: options.statePath(repo.GitDir)}}
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	defer server.Close()
	if cli.json {
		err = json.NewEncoder(stdout).Encode(map[string]any{"port": actualPort, "repoId": id, "url": address})
	} else if options.PoC {
		_, err = fmt.Fprintln(stdout, address)
	} else {
		_, err = fmt.Fprintf(stdout, "ghl serving %s\n  base %s (%s)\n  %s\n", repo.Path, review.Base, review.Resolution.Source, address)
	}
	if err != nil {
		listener.Close()
		return err
	}
	if runtime.GOOS == "darwin" && !cli.noOpen {
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
