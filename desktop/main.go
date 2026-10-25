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

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
	// The Finder, Spotlight and the Dock start the app through launchd, from /
	// and without arguments: open the window rather than a review of /.
	windowMode := len(args) == 0 && os.Getppid() == 1
	if len(args) > 0 && args[0] == "--desktop-window" {
		windowMode = true
		args = args[1:]
	} else if !windowMode {
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
	if probePath == "" {
		go func() {
			stopLegacyDaemon(legacyDaemon, dir)
			if home, err := os.UserHomeDir(); err == nil {
				removeSourceCLI(home)
			}
		}()
	}
	if len(args) > 0 {
		requests <- initial
	}
	assets, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	backend, err := startBackend(context.Background(), assets)
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
	// Tabs are off for now; GHL_DESKTOP_TABS=1 keeps them for the smoke tests.
	desktop.tabs.single = os.Getenv("GHL_DESKTOP_TABS") != "1"
	compact := settings.compactTitleBar()
	handler, err := desktopAssets(assets, backend.handler(), compact)
	if err != nil {
		return err
	}
	native := application.New(application.Options{
		Name:     "ghl",
		Assets:   application.AssetOptions{Handler: handler, DisableLogging: true},
		Services: []application.Service{application.NewService(desktop)},
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		// Stop taking reviews first: a launcher that finds no app starts a new one,
		// instead of getting a receipt for a review this app will never open.
		OnShutdown: func() {
			owner.close()
			backend.close()
		},
	})
	window := native.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "review", Title: "ghl", URL: "/", JS: string(probe),
		Width: 1280, Height: 800, MinWidth: 800, MinHeight: 500,
		// Width and Height are the size the window's zoom button returns to.
		StartState: application.WindowStateMaximised,
		// Translucent until the page paints: launch shows the system material in
		// either appearance instead of a fixed colour.
		BackgroundType: application.BackgroundTypeTranslucent,
		Mac: application.MacWindow{
			TitleBar: titleBar(compact),
			Backdrop: application.MacBackdropTranslucent,
		},
	})
	desktop.startup(native, window)
	desktop.addFileMenu(native, window)
	window.OnWindowEvent(events.Common.WindowRuntimeReady, func(*application.WindowEvent) {
		desktop.ready.Do(func() { go desktop.process(context.Background()) })
	})
	// Closing the review quits the app, so Settings must not keep it running.
	window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { desktop.closeSettings() })
	// Every menu item reaches the page as one named command: the shell takes the
	// window's, the mounted review the rest. Single-letter shortcuts stay in the
	// page, since a key without a modifier would also capture typing.
	command := func(name string) func(*application.Context) {
		js := fmt.Sprintf("window.dispatchEvent(new CustomEvent('desktop:command', {detail: %q}))", name)
		return func(*application.Context) { window.ExecJS(js) }
	}
	item := func(menu *application.Menu, label, accelerator string, action func(*application.Context)) {
		entry := menu.Add(label).OnClick(action)
		if accelerator != "" {
			entry.SetAccelerator(accelerator)
		}
	}
	appMenu := native.Menu.New()
	// Wails' AppMenu role, with Settings where macOS apps keep it. Its Show All
	// is the UnHide role, which has no selector; ShowAll has one.
	ghlMenu := appMenu.AddSubmenu("ghl")
	ghlMenu.AddRole(application.About)
	ghlMenu.AddSeparator()
	item(ghlMenu, "Settings…", "CmdOrCtrl+,", func(*application.Context) { desktop.openSettings() })
	ghlMenu.AddSeparator()
	ghlMenu.AddRole(application.ServicesMenu)
	ghlMenu.AddSeparator()
	ghlMenu.AddRole(application.Hide)
	ghlMenu.AddRole(application.HideOthers)
	ghlMenu.AddRole(application.ShowAll)
	ghlMenu.AddSeparator()
	ghlMenu.AddRole(application.Quit)
	fileMenu := appMenu.AddSubmenu("File")
	item(fileMenu, "Open Repository…", "CmdOrCtrl+o", func(*application.Context) { desktop.chooseRepository() })
	closeReview := command("close-tab")
	item(fileMenu, "Close Review", "CmdOrCtrl+w", func(ctx *application.Context) {
		// The menu belongs to the app: in Settings, Cmd+W closes Settings, not the review behind it.
		if current := native.Window.Current(); current != nil && current.Name() == settingsWindow {
			current.Close()
			return
		}
		closeReview(ctx)
	})
	appMenu.AddRole(application.EditMenu)
	viewMenu := appMenu.AddSubmenu("View")
	item(viewMenu, "Toggle Sidebar", "Ctrl+CmdOrCtrl+s", command("sidebar"))
	item(viewMenu, "Reload", "CmdOrCtrl+r", command("reload"))
	viewMenu.AddSeparator()
	item(viewMenu, "Unified", "CmdOrCtrl+1", command("unified"))
	item(viewMenu, "Split", "CmdOrCtrl+2", command("split"))
	viewMenu.AddSeparator()
	item(viewMenu, "Include Working Tree", "", command("working-tree"))
	item(viewMenu, "Include Untracked Files", "", command("untracked"))
	item(viewMenu, "Ignore Whitespace", "OptionOrAlt+CmdOrCtrl+w", command("whitespace"))
	viewMenu.AddSeparator()
	item(viewMenu, "Comments", "OptionOrAlt+CmdOrCtrl+0", command("comments"))
	goMenu := appMenu.AddSubmenu("Go")
	item(goMenu, "Next File", "", command("next-file"))
	item(goMenu, "Previous File", "", command("previous-file"))
	goMenu.AddSeparator()
	item(goMenu, "Choose Base…", "", command("base"))
	item(goMenu, "Choose Target…", "", command("target"))
	item(goMenu, "Choose Commit…", "", command("commit"))
	goMenu.AddSeparator()
	item(goMenu, "Choose Stack Layer…", "", command("stack"))
	item(goMenu, "Layer Below", "", command("layer-below"))
	item(goMenu, "Layer Above", "", command("layer-above"))
	reviewMenu := appMenu.AddSubmenu("Review")
	item(reviewMenu, "Mark as Viewed", "", command("viewed"))
	item(reviewMenu, "Comment on Selection", "", command("comment"))
	reviewMenu.AddSeparator()
	item(reviewMenu, "Copy File Path", "", command("copy-path"))
	item(reviewMenu, "Reveal in Finder", "", command("reveal"))
	item(reviewMenu, "Reset Viewed", "", command("reset-viewed"))
	reviewMenu.AddSeparator()
	item(reviewMenu, "Copy All Comments", "Shift+CmdOrCtrl+c", command("copy-comments"))
	appMenu.AddRole(application.WindowMenu)
	helpMenu := appMenu.AddSubmenu("Help")
	item(helpMenu, "Keyboard Shortcuts", "", command("shortcuts"))
	native.Menu.Set(appMenu)
	// Wails quits on SIGINT and SIGTERM itself, through OnShutdown.
	return native.Run()
}

// titleBar centres the window buttons in a 38 px compact toolbar, or in the 52 px unified one.
func titleBar(compact bool) application.MacTitleBar {
	bar := application.MacTitleBarHiddenInset
	if compact {
		bar.ToolbarStyle = application.MacToolbarStyleUnifiedCompact
	}
	return bar
}
