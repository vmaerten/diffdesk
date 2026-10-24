// Desktop application. The production Go module stays dependency-free.
package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:assets
var embedded embed.FS

//go:embed bridge.js
var bridge string

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ghl:", err)
		os.Exit(1)
	}
}

func run() error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	args := os.Args[1:]
	windowMode := len(args) > 0 && args[0] == "--desktop-window"
	if windowMode {
		args = args[1:]
	} else {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		handled, err := runTerminal(ctx, args, cwd, os.Stdout, os.Stderr)
		cancel()
		if errors.Is(err, flag.ErrHelp) {
			fmt.Print(help)
			return nil
		}
		if handled {
			return err
		}
	}
	initial, err := parseLaunch(args, cwd)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Print(help)
		return nil
	}
	if err != nil {
		return err
	}
	// Local acceptance tests may supply a probe; its path also keeps their app
	// apart from the user's.
	probePath := os.Getenv("GHL_DESKTOP_PROBE")
	instanceID := "cf7c8359-dbb0-4c1c-a09f-301b26d2a917"
	if probePath != "" {
		instanceID = fmt.Sprintf("ghl-test-%x", sha256.Sum256([]byte(probePath)))
	}
	// Per user on macOS, and the socket path must stay short.
	dir := userTempDir()
	if !windowMode {
		// A running app takes the review at once.
		if err := deliver(dir, instanceID, initial, 0); !errors.Is(err, errNoApp) {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return err
		}
		bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
		if filepath.Ext(bundle) != ".app" {
			return fmt.Errorf("run ghl from its .app bundle (task desktop:run)")
		}
		// LaunchServices gives the window a Dock identity. Concurrent launchers may
		// each start one: a single app wins the lock and they all deliver to it.
		openArgs := []string{"-n", "-a", bundle}
		if probePath != "" {
			openArgs = append(openArgs, "--env", "GHL_DESKTOP_PROBE="+probePath)
		}
		if err := exec.Command("/usr/bin/open", append(openArgs, "--args", "--desktop-window")...).Run(); err != nil {
			return err
		}
		if err := deliver(dir, instanceID, initial, 20*time.Second); errors.Is(err, errNoApp) {
			return fmt.Errorf("the ghl app did not start")
		} else {
			return err
		}
	}
	requests := make(chan launch, 16)
	owner, err := claimInstance(dir, instanceID)
	if err != nil {
		return err
	}
	if owner == nil {
		// Another app runs: hand it this window's review, if any, and leave.
		if len(args) == 0 {
			return nil
		}
		return deliver(dir, instanceID, initial, 5*time.Second)
	}
	defer owner.close()
	// Listening before the backend starts: a request sent during startup waits in the queue.
	go owner.serve(func(request launch) error { return enqueue(requests, request) })
	if len(args) > 0 {
		requests <- initial
	}
	assets, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	backend, err := startBackend(ctx, assets)
	if err != nil {
		return err
	}
	defer backend.close()
	// No test script runs by default.
	var probe []byte
	if probePath != "" {
		probe, err = os.ReadFile(probePath)
		if err != nil {
			return err
		}
	}
	settings, err := newSettingsStore()
	if err != nil {
		return err
	}
	desktop := &desktopApp{backend: backend, requests: requests, settings: settings}
	// Every menu item reaches the page as one named command: the shell takes the
	// window's, the mounted review the rest. Single-letter shortcuts stay in the
	// page, since a key without a modifier would also capture typing.
	command := func(name string) func(*menu.CallbackData) {
		return func(*menu.CallbackData) {
			runtime.WindowExecJS(desktop.runtimeContext(),
				fmt.Sprintf("window.dispatchEvent(new CustomEvent('desktop:command', {detail: %q}))", name))
		}
	}
	optionCmd := func(key string) *keys.Accelerator {
		return keys.Combo(key, keys.OptionOrAltKey, keys.CmdOrCtrlKey)
	}
	appMenu := menu.NewMenu()
	appMenu.Append(menu.AppMenu())
	fileMenu := appMenu.AddSubmenu("File")
	fileMenu.AddText("Open Repository…", keys.CmdOrCtrl("o"), func(*menu.CallbackData) { desktop.chooseRepository() })
	fileMenu.AddText("Close Tab", keys.CmdOrCtrl("w"), command("close-tab"))
	// Wails v2 builds the application menu itself, leaving no room for Settings there.
	fileMenu.AddSeparator()
	fileMenu.AddText("Settings…", keys.CmdOrCtrl(","), command("settings"))
	appMenu.Append(menu.EditMenu())
	viewMenu := appMenu.AddSubmenu("View")
	viewMenu.AddText("Toggle Sidebar", keys.Combo("s", keys.ControlKey, keys.CmdOrCtrlKey), command("sidebar"))
	viewMenu.AddText("Reload", keys.CmdOrCtrl("r"), command("reload"))
	viewMenu.AddSeparator()
	viewMenu.AddText("Unified", keys.CmdOrCtrl("1"), command("unified"))
	viewMenu.AddText("Split", keys.CmdOrCtrl("2"), command("split"))
	viewMenu.AddSeparator()
	viewMenu.AddText("Include Working Tree", nil, command("working-tree"))
	viewMenu.AddText("Include Untracked Files", nil, command("untracked"))
	viewMenu.AddText("Ignore Whitespace", optionCmd("w"), command("whitespace"))
	viewMenu.AddSeparator()
	viewMenu.AddText("Comments", optionCmd("0"), command("comments"))
	goMenu := appMenu.AddSubmenu("Go")
	goMenu.AddText("Next File", nil, command("next-file"))
	goMenu.AddText("Previous File", nil, command("previous-file"))
	goMenu.AddSeparator()
	goMenu.AddText("Choose Base…", nil, command("base"))
	goMenu.AddText("Choose Target…", nil, command("target"))
	goMenu.AddText("Choose Commit…", nil, command("commit"))
	reviewMenu := appMenu.AddSubmenu("Review")
	reviewMenu.AddText("Mark as Viewed", nil, command("viewed"))
	reviewMenu.AddText("Comment on Selection", nil, command("comment"))
	reviewMenu.AddSeparator()
	reviewMenu.AddText("Copy File Path", nil, command("copy-path"))
	reviewMenu.AddText("Reveal in Finder", nil, command("reveal"))
	reviewMenu.AddText("Reset Viewed", nil, command("reset-viewed"))
	reviewMenu.AddSeparator()
	reviewMenu.AddText("Copy All Comments", keys.Combo("c", keys.ShiftKey, keys.CmdOrCtrlKey), command("copy-comments"))
	appMenu.Append(menu.WindowMenu())
	helpMenu := appMenu.AddSubmenu("Help")
	helpMenu.AddText("Keyboard Shortcuts", nil, command("shortcuts"))
	return wails.Run(&options.App{
		Title: "ghl", Width: 1280, Height: 800, MinWidth: 800, MinHeight: 500,
		// The runtime limits this menu to fields and selected text; disabling it
		// would also remove Copy and Paste there.
		Menu: appMenu, EnableDefaultContextMenu: true,
		// Transparent until the page paints: launch shows the system material in
		// either appearance instead of a fixed dark colour.
		BackgroundColour: options.NewRGBA(0, 0, 0, 0),
		Mac: &mac.Options{
			TitleBar:             mac.TitleBarHiddenInset(),
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
		},
		AssetServer: &assetserver.Options{Handler: backend.handler()},
		Bind:        []interface{}{desktop},
		OnStartup: func(windowCtx context.Context) {
			desktop.startup(windowCtx)
			go func() {
				select {
				case <-ctx.Done():
					runtime.Quit(windowCtx)
				case <-windowCtx.Done():
				}
			}()
		},
		OnDomReady: func(ctx context.Context) {
			runtime.WindowExecJS(ctx, bridge)
			if len(probe) > 0 {
				runtime.WindowExecJS(ctx, string(probe))
			}
			desktop.ready.Do(func() { go desktop.process(ctx) })
		},
		OnShutdown: func(context.Context) { backend.close() },
	})
}
