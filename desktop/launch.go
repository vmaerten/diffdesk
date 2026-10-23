package main

import (
	"context"
	"flag"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const help = `ghl — review the PR you are about to open, without opening it (macOS)

Usage:
  ghl [target] [--repo <path>] [--base <ref>]
  ghl comments [target] [--repo <path>] [--base <ref>] [--json]

  target     Branch or revision; defaults to the checkout and its working tree.
  comments   Print this comparison's comments with their code, as Markdown or,
             with --json, JSON. Use refs/heads/comments for a branch named "comments".

Options:
  --repo <path>  Repository to review (default: current directory)
  --base <rev>   Compare against <rev> instead of the automatically resolved base
  --version      Print version and build metadata, as JSON with --json
  -h, --help     Show this help

Opens or activates a review tab in the ghl window, then returns to the terminal.
Relative paths are resolved from the calling terminal, including later launches.
Cmd+O opens another repository; Cmd+W closes a tab; Cmd+R reloads; Cmd+Q quits.
Comments and Viewed live in each checkout's .git/ghl/state.json.
`

type launch struct {
	repo, base, target string
}

func (request launch) arguments() []string {
	args := []string{"--repo", request.repo}
	if request.base != "" {
		args = append(args, "--base", request.base)
	}
	if request.target != "" {
		args = append(args, request.target)
	}
	return args
}

// Deliveries from other processes are untrusted input; accept only this small CLI surface.
func parseLaunch(args []string, cwd string) (launch, error) {
	result := launch{repo: cwd}
	if !filepath.IsAbs(cwd) {
		return result, fmt.Errorf("the calling directory must be absolute")
	}
	positional := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !positional && (arg == "--help" || arg == "-h") {
			return result, flag.ErrHelp
		}
		if !positional && arg == "--" {
			positional = true
			continue
		}
		if !positional && strings.HasPrefix(arg, "-") {
			name, value, inline := strings.Cut(arg, "=")
			if name != "--repo" && name != "--base" {
				return result, fmt.Errorf("unknown option %q; use --help", arg)
			}
			if !inline {
				i++
				if i == len(args) {
					return result, fmt.Errorf("%s needs a value", name)
				}
				value = args[i]
			}
			if value == "" || strings.HasPrefix(value, "-") || strings.ContainsRune(value, 0) {
				return result, fmt.Errorf("invalid value for %s", name)
			}
			if name == "--repo" {
				result.repo = value
			} else {
				result.base = value
			}
			continue
		}
		if arg == "" || strings.HasPrefix(arg, "-") || strings.ContainsRune(arg, 0) || result.target != "" {
			return result, fmt.Errorf("unexpected target %q", arg)
		}
		result.target = arg
	}
	if !filepath.IsAbs(result.repo) {
		result.repo = filepath.Join(cwd, result.repo)
	}
	result.repo = filepath.Clean(result.repo)
	return result, nil
}

type desktopApp struct {
	ctx      context.Context
	mu       sync.RWMutex
	backend  *reviewBackend
	requests chan launch
	ready    sync.Once
	tabs     reviewTabs
	settings *settingsStore
}

func (d *desktopApp) startup(ctx context.Context) {
	d.mu.Lock()
	d.ctx = ctx
	d.mu.Unlock()
}

func (d *desktopApp) runtimeContext() context.Context {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.ctx
}

// enqueue queues a request for the window without waiting for it to open.
func enqueue(requests chan<- launch, request launch) error {
	select {
	case requests <- request:
		return nil
	default:
		return fmt.Errorf("too many pending openings; retry")
	}
}

func (d *desktopApp) process(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-d.requests:
			work, cancel := context.WithTimeout(ctx, 30*time.Second)
			route, checkout, err := d.backend.open(work, request)
			cancel()
			if err != nil {
				d.showError(err)
				continue
			}
			d.publish(d.tabs.open(route, checkout))
			runtime.WindowUnminimise(ctx)
			runtime.Show(ctx)
		}
	}
}

func (d *desktopApp) publish(state tabSnapshot) tabSnapshot {
	if ctx := d.runtimeContext(); ctx != nil {
		runtime.EventsEmit(ctx, "desktop:tabs", state)
	}
	return state
}

func (d *desktopApp) chooseRepository() {
	path, err := runtime.OpenDirectoryDialog(d.runtimeContext(), runtime.OpenDialogOptions{Title: "Open a Git repository"})
	if err != nil {
		d.showError(err)
		return
	}
	if path != "" {
		if err := enqueue(d.requests, launch{repo: path}); err != nil {
			d.showError(err)
		}
	}
}

func (d *desktopApp) showError(err error) {
	fmt.Println("ghl:", err)
	if ctx := d.runtimeContext(); ctx != nil {
		runtime.WindowUnminimise(ctx)
		runtime.Show(ctx)
		_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
			Type: runtime.ErrorDialog, Title: "Could not open repository", Message: err.Error(),
		})
	}
}
