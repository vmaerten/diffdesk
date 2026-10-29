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
		fmt.Fprintln(os.Stderr, "diffdesk:", err)
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
		instanceID = fmt.Sprintf("diffdesk-test-%x", sha256.Sum256([]byte(probePath)))
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
			return fmt.Errorf("run diffdesk from its .app bundle (task desktop:run)")
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
			return fmt.Errorf("Diffdesk did not start")
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
	updateContext, cancelUpdates := context.WithCancel(context.Background())
	defer cancelUpdates()
	updater := &nativeUpdater{desktop: desktop, ctx: updateContext, skipPath: filepath.Join(filepath.Dir(settings.path), "skipped-update")}
	updater.session.skipped = loadSkippedVersion(updater.skipPath)
	desktop.updater = updater
	native := application.New(application.Options{
		Name:     "Diffdesk",
		Assets:   application.AssetOptions{Handler: handler, DisableLogging: true},
		Services: []application.Service{application.NewService(desktop)},
		Mac:      application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		// Stop taking reviews first: a launcher that finds no app starts a new one,
		// instead of getting a receipt for a review this app will never open.
		OnShutdown: func() {
			cancelUpdates()
			owner.close()
			backend.close()
		},
	})
	window := native.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "review", Title: "Diffdesk", URL: "/", JS: string(probe),
		// Width and Height are the size the window's zoom button returns to.
		Width: 1280, Height: 800, MinWidth: 800, MinHeight: 500,
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
		desktop.ready.Do(func() {
			// Wails centres the window after applying StartState, cancelling
			// AppKit's zoom animation. Maximise once that setup has finished.
			window.Maximise()
			go desktop.process(context.Background())
			updater.check(false)
		})
	})
	// Closing the review quits the app, so Settings must not keep it running.
	window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) { desktop.closeSettings() })
	// Wails reloads the page after its renderer dies, which the new page cannot
	// tell apart from a reload it asked for.
	window.OnWindowEvent(events.Mac.WebViewWebContentProcessDidTerminate, func(*application.WindowEvent) {
		if err := desktop.settings.recordNativeEvent("webview.terminated", map[string]any{"window": "review"}); err != nil {
			fmt.Fprintln(os.Stderr, "diffdesk: debug log:", err)
		}
	})
	// Every menu item reaches the page as one named command: the shell takes the
	// window's, the mounted review the rest. Single-letter shortcuts stay in the
	// page, since a key without a modifier would also capture typing. The command
	// palette repeats the labels and accelerators, in web/src/commands.ts.
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
	diffdeskMenu := appMenu.AddSubmenu("Diffdesk")
	diffdeskMenu.AddRole(application.About)
	updater.menu = diffdeskMenu.Add("Check for Updates…").OnClick(func(*application.Context) { updater.check(true) })
	diffdeskMenu.AddSeparator()
	item(diffdeskMenu, "Settings…", "CmdOrCtrl+,", func(*application.Context) { desktop.openSettings() })
	diffdeskMenu.AddSeparator()
	diffdeskMenu.AddRole(application.ServicesMenu)
	diffdeskMenu.AddSeparator()
	diffdeskMenu.AddRole(application.Hide)
	diffdeskMenu.AddRole(application.HideOthers)
	diffdeskMenu.AddRole(application.ShowAll)
	diffdeskMenu.AddSeparator()
	diffdeskMenu.AddRole(application.Quit)
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
	// Settings has no palette, and the review's would open behind it.
	palette := func(name string) func(*application.Context) {
		open := command(name)
		return func(ctx *application.Context) {
			if current := native.Window.Current(); current != nil && current.Name() == settingsWindow {
				return
			}
			open(ctx)
		}
	}
	viewMenu := appMenu.AddSubmenu("View")
	item(viewMenu, "Command Palette…", "CmdOrCtrl+k", palette("palette"))
	viewMenu.AddSeparator()
	item(viewMenu, "Toggle Sidebar", "Ctrl+CmdOrCtrl+s", command("sidebar"))
	item(viewMenu, "Reload", "CmdOrCtrl+r", command("reload"))
	viewMenu.AddSeparator()
	item(viewMenu, "Zoom In", "CmdOrCtrl+plus", palette("zoom-in"))
	item(viewMenu, "Zoom Out", "CmdOrCtrl+-", palette("zoom-out"))
	item(viewMenu, "Actual Size", "CmdOrCtrl+0", palette("zoom-reset"))
	viewMenu.AddSeparator()
	item(viewMenu, "Unified", "CmdOrCtrl+1", command("unified"))
	item(viewMenu, "Split", "CmdOrCtrl+2", command("split"))
	// ⌥Z is the page's: as an accelerator it would take a character from the comment field.
	item(viewMenu, "Wrap Lines", "", command("wrap-lines"))
	viewMenu.AddSeparator()
	item(viewMenu, "Include Working Tree", "", command("working-tree"))
	item(viewMenu, "Include Untracked Files", "", command("untracked"))
	item(viewMenu, "Ignore Whitespace", "OptionOrAlt+CmdOrCtrl+w", command("whitespace"))
	viewMenu.AddSeparator()
	item(viewMenu, "Comments", "OptionOrAlt+CmdOrCtrl+0", command("comments"))
	goMenu := appMenu.AddSubmenu("Go")
	item(goMenu, "Go to File…", "CmdOrCtrl+p", palette("go-to-file"))
	goMenu.AddSeparator()
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
