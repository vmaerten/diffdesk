package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vmaerten/diffdesk/internal/app"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails owns the package-manager work; the review document only displays
// snapshots and asks to check, dismiss or install the offered version.
type nativeUpdater struct {
	desktop  *desktopApp
	ctx      context.Context
	session  updateSession
	schedule updateSchedule
	menu     *application.MenuItem
	// Beside the settings, which belong to the UI.
	skipPath string
}

func (u *nativeUpdater) publish(state updateSnapshot) {
	if u.ctx.Err() != nil {
		return
	}
	native, _ := u.desktop.native()
	native.Event.Emit("desktop:update", state)
	application.InvokeAsync(func() {
		if u.ctx.Err() != nil {
			return
		}
		u.session.mu.Lock()
		busy := u.session.busy
		status := u.session.state.Status
		u.session.mu.Unlock()
		label := "Check for Updates…"
		if busy {
			label = "Checking for Updates…"
			if status == "installing" || status == "restarting" {
				label = "Installing Update…"
			}
		}
		u.menu.SetLabel(label).SetEnabled(!busy)
	})
}

func (u *nativeUpdater) check(manual bool) {
	if u.ctx.Err() != nil {
		return
	}
	state, started := u.session.startCheck(manual)
	if !started {
		return
	}
	u.publish(state)
	at := time.Now()
	u.schedule.started(at)
	go func() {
		ctx, cancel := context.WithTimeout(u.ctx, 30*time.Second)
		defer cancel()
		info := app.Build()
		finish := func(installation updateInstallation, offered updateRelease, err error, retry string) {
			u.schedule.finished(at, retry == "check")
			u.publish(u.session.checked(installation, info.Version, offered, err, retry, manual))
		}
		fail := func(err error, retry string) { finish(updateInstallation{}, updateRelease{}, err, retry) }
		if os.Getenv("DIFFDESK_DESKTOP_PROBE") != "" {
			fail(fmt.Errorf("updates are disabled in acceptance tests"), "")
			return
		}
		if _, ok := stableVersion(info.Version); !ok {
			fail(fmt.Errorf("automatic updates are available for stable release builds"), "")
			return
		}
		// Source builds and smoke tests never make background requests or
		// offer to change a separately installed copy of the app.
		if !manual && strings.HasSuffix(info.Commit, "-dirty") {
			finish(updateInstallation{}, updateRelease{}, nil, "")
			return
		}
		executable, err := os.Executable()
		if err != nil {
			fail(err, "check")
			return
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			fail(err, "check")
			return
		}
		bundle := filepath.Dir(filepath.Dir(filepath.Dir(executable)))
		installation, err := detectUpdateInstallation(ctx, bundle, info.Version, findUpdateCommand("brew"), findUpdateCommand("mise"), runUpdateCommand)
		if err != nil {
			fail(err, "")
			return
		}
		version, err := latestUpdate(ctx, http.DefaultClient, latestReleaseURL, info.Version)
		if err != nil {
			fail(err, "check")
			return
		}
		finish(installation, version, nil, "")
	}()
}

// daily checks again each day from 10:00, local time, while the app runs.
func (u *nativeUpdater) daily() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-u.ctx.Done():
			return
		case <-ticker.C:
			if u.schedule.due(time.Now().In(systemZone())) {
				u.check(false)
			}
		}
	}
}

func (d *desktopApp) UpdateStatus() updateSnapshot { return d.updater.session.snapshot() }
func (d *desktopApp) CheckForUpdates()             { d.updater.check(true) }
func (d *desktopApp) DismissUpdate() updateSnapshot {
	state := d.updater.session.dismiss()
	d.updater.publish(state)
	return state
}

// SkipUpdate dismisses the offered version until a newer one, or a check the user asks for.
func (d *desktopApp) SkipUpdate() (updateSnapshot, error) {
	state, version := d.updater.session.skip()
	d.updater.publish(state)
	if version == "" {
		return state, nil
	}
	return state, saveSkippedVersion(d.updater.skipPath, version)
}

// No path, version or command is accepted from the page. A confirmation can
// only install the version the backend has already checked and offered.
func (d *desktopApp) InstallUpdate() (updateSnapshot, error) {
	u := d.updater
	if u.ctx.Err() != nil {
		return u.session.snapshot(), u.ctx.Err()
	}
	state, installation, started := u.session.startInstall()
	if !started {
		return state, fmt.Errorf("no update is available, or an update is already in progress")
	}
	u.publish(state)
	go u.install(installation, state.Version)
	return state, nil
}

func (u *nativeUpdater) install(installation updateInstallation, version string) {
	ctx, cancel := context.WithTimeout(u.ctx, 10*time.Minute)
	defer cancel()
	bundle, err := installation.install(ctx, version, runUpdateCommand)
	if err != nil {
		u.publish(u.session.installFailed(err.Error()+"\n\nDiffdesk will keep running. Try again later.", true))
		return
	}
	if u.ctx.Err() != nil {
		return
	}
	// Wait for this process to exit and release the single-instance lock.
	command := updateRestartCommand(os.Getpid(), bundle, u.desktop.tabs.snapshot())
	if err := command.Start(); err != nil {
		u.publish(u.session.installFailed("The update is installed. Quit and reopen Diffdesk to use it. Could not schedule the restart: "+err.Error(), false))
		return
	}
	_ = command.Process.Release()
	u.publish(u.session.restarting())
	native, _ := u.desktop.native()
	native.Quit()
}

func updateRestartCommand(pid int, bundle string, state tabSnapshot) *exec.Cmd {
	// Pass every path/ref as an argument, including spaces and shell syntax.
	// The bounded wait avoids leaving a helper behind if shutdown stalls.
	const script = `pid=$1; shift
attempt=0
while kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 300 ] || exit 1
  /bin/sleep 0.1
done
exec /usr/bin/open -n -a "$@"`
	args := []string{"-c", script, "diffdesk-update", strconv.Itoa(pid), bundle, "--args", "--desktop-window"}
	for _, tab := range state.Tabs {
		if tab.ID == state.Active {
			route, err := url.Parse(tab.Route)
			if err == nil {
				request := launch{repo: tab.checkout, base: route.Query().Get("base"), target: route.Query().Get("target")}
				args = append(args, request.arguments()...)
			}
			break
		}
	}
	command := exec.Command("/bin/sh", args...)
	command.Dir = "/"
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return command
}
