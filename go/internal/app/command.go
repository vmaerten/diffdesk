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
	"net/url"
	"os/exec"
	"path/filepath"
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
	directory := "ghl"
	if o.PoC {
		directory = "ghl-go-poc"
	}
	return filepath.Join(gitDir, directory, "state.json")
}

func (o Options) store(repo Repository) *Store {
	return &Store{path: o.statePath(repo.GitDir), gitDir: repo.GitDir}
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
	if cli.daemon {
		if err := checkAssets(options); err != nil {
			return err
		}
		revision, err := runtimeRevision()
		if err != nil {
			return err
		}
		listener, server, err := listenRuntime(cli.port, options, revision, true)
		if err != nil {
			return err
		}
		defer listener.Close()
		// The private readiness pipe also announces the chosen ephemeral port.
		if err := json.NewEncoder(stdout).Encode(map[string]int{"port": listener.Addr().(*net.TCPAddr).Port}); err != nil {
			return err
		}
		go server.watchIdle(ctx, cli.idle)
		return serveHTTP(ctx, listener, server, server.stopped)
	}
	repo, err := openRepository(ctx, cli.repo)
	if err != nil {
		return err
	}
	if cli.importState != "" {
		store := options.store(repo)
		result, err := store.Import(ctx, cli.importState)
		if err != nil {
			return err
		}
		if store.notice != nil {
			fmt.Fprintln(stderr, "ghl:", *store.notice)
		}
		if cli.json {
			return json.NewEncoder(stdout).Encode(result)
		}
		_, err = fmt.Fprintf(stdout, "Imported %d comment(s) and %d Viewed entry(s) into %s\n", result.Comments, result.Viewed, store.path)
		if err == nil && result.Backup != nil {
			_, err = fmt.Fprintln(stdout, "Previous state:", *result.Backup)
		}
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
		return writeComments(ctx, review, options.store(repo), cli.json, stdout, stderr)
	}
	if cli.print {
		return writeSummary(review, cli.target, stdout)
	}
	if err := checkAssets(options); err != nil {
		return err
	}
	var listener net.Listener
	var handler *reviewRuntime
	var revision string
	if !options.PoC {
		revision, err = runtimeRevision()
		if err != nil {
			return err
		}
	}
	actualPort := cli.port
	if !options.PoC && !cli.noDaemon {
		actualPort, err = useDaemon(ctx, cli, repo, revision, stderr)
	} else if options.PoC {
		listener, err = net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", cli.port))
	} else {
		listener, handler, err = listenRuntime(cli.port, options, revision, false)
		if err == nil {
			_, err = handler.register(repo)
		}
	}
	if err != nil {
		if listener != nil {
			listener.Close()
		}
		return err
	}
	if listener != nil {
		defer listener.Close()
		actualPort = listener.Addr().(*net.TCPAddr).Port
	}
	id := repoID(repo.Path)
	host := "127.0.0.1"
	if !options.PoC {
		host = displayHost(ctx)
	}
	address := fmt.Sprintf("http://%s:%d/r/%s", host, actualPort, url.PathEscape(id))
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
	if cli.json {
		err = json.NewEncoder(stdout).Encode(map[string]any{"port": actualPort, "repoId": id, "url": address})
	} else if options.PoC {
		_, err = fmt.Fprintln(stdout, address)
	} else {
		_, err = fmt.Fprintf(stdout, "ghl serving %s\n  base %s (%s)\n  %s\n", repo.Path, review.Base, review.Resolution.Source, address)
	}
	if err != nil {
		return err
	}
	if !cli.noOpen {
		if err := openBrowser(ctx, address); err != nil {
			fmt.Fprintln(stderr, "Could not open browser:", err)
		}
	}
	if listener == nil {
		return nil
	}
	if options.PoC {
		server := &Server{repo: repo, id: id, base: cli.base, assets: options.Assets, poc: true, store: options.store(repo)}
		return serveHTTP(ctx, listener, server, nil)
	}
	return serveHTTP(ctx, listener, handler, handler.stopped)
}

func checkAssets(options Options) error {
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
	return nil
}

func listenRuntime(port int, options Options, revision string, daemon bool) (net.Listener, *reviewRuntime, error) {
	server, err := newRuntime(options, revision, daemon)
	if err != nil {
		return nil, nil, err
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, nil, fmt.Errorf("Could not listen on port %d: %w; choose --port or GHL_PORT", port, err)
	}
	return listener, server, nil
}
