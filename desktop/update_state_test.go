package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestUpdateSessionDismissAndRetry(t *testing.T) {
	var session updateSession
	installation := updateInstallation{"Homebrew", "/fixture/brew", "/fixture/Diffdesk.app"}
	if state, _, ok := session.startInstall(); ok || state.Version != "" {
		t.Fatal("a page installed a version that was never offered")
	}
	if state, ok := session.startCheck(false); !ok || state.Status != "idle" {
		t.Fatal("a startup check interrupted the review")
	}
	state := session.checked(installation, "0.6.0", updateRelease{Version: "0.7.0", Notes: "### Features\n\n- Better reviews"}, nil, "", false)
	if state.Notes != "### Features\n\n- Better reviews" || state.Status != "available" || state.Version != "0.7.0" || state.Manager != "Homebrew" {
		t.Fatalf("offer: %+v", state)
	}
	dismissed := session.dismiss()
	if dismissed.Status != "idle" || dismissed.Revision <= state.Revision {
		t.Fatalf("Later: %+v", dismissed)
	}
	if _, _, ok := session.startInstall(); ok {
		t.Fatal("a late confirmation installed a dismissed offer")
	}
	session.startCheck(true)
	session.checked(installation, "0.6.0", updateRelease{Version: "0.7.0", Notes: "### Features\n\n- Better reviews"}, nil, "", true)
	state, target, ok := session.startInstall()
	if !ok || target != installation || state.Status != "installing" || state.Version != "0.7.0" {
		t.Fatalf("install: %+v %+v %v", state, target, ok)
	}
	if session.dismiss().Status != "installing" {
		t.Fatal("dismiss interrupted an installation")
	}
	if _, ok := session.startCheck(true); ok {
		t.Fatal("a check ran alongside installation")
	}
	failed := session.installFailed("cask not ready", true)
	if failed.Notes != "### Features\n\n- Better reviews" || failed.Status != "error" || failed.Retry != "install" || failed.Message != "cask not ready" {
		t.Fatalf("failed: %+v", failed)
	}
	if state, retryTarget, ok := session.startInstall(); !ok || retryTarget != target || state.Revision <= failed.Revision {
		t.Fatal("retry lost the checked installation")
	}
	if session.restarting().Status != "restarting" {
		t.Fatal("verified update did not transition to restart")
	}
	if session.dismiss().Status != "restarting" {
		t.Fatal("dismiss interrupted restart")
	}
}

func TestUpdateSessionCheckResults(t *testing.T) {
	for _, manual := range []bool{false, true} {
		var session updateSession
		state, _ := session.startCheck(manual)
		if manual && state.Status != "checking" {
			t.Fatal("manual check has no feedback")
		}
		failure := session.checked(updateInstallation{}, "0.6.0", updateRelease{}, errors.New("offline"), "check", manual)
		if manual {
			if failure.Status != "error" || failure.Retry != "check" || failure.Message != "offline" {
				t.Fatalf("manual failure: %+v", failure)
			}
		} else if failure.Status != "idle" || failure.Message != "" {
			t.Fatalf("startup failure interrupted the review: %+v", failure)
		}
		if _, _, ok := session.startInstall(); ok {
			t.Fatal("a check failure offered an install retry")
		}
		session.startCheck(manual)
		current := session.checked(updateInstallation{}, "0.6.0", updateRelease{}, nil, "", manual)
		if manual && (current.Status != "current" || current.Version != "0.6.0") {
			t.Fatalf("up to date: %+v", current)
		} else if !manual && current.Status != "idle" {
			t.Fatal("up-to-date startup check was visible")
		}
	}
}

func TestUpdateSessionSerializesConcurrentInstalls(t *testing.T) {
	var session updateSession
	session.startCheck(true)
	session.checked(updateInstallation{"mise", "/fixture/mise", "/fixture/app"}, "0.6.0", updateRelease{Version: "0.7.0", Notes: "### Features\n\n- Better reviews"}, nil, "", true)
	var installed atomic.Int32
	var group sync.WaitGroup
	for range 32 {
		group.Go(func() {
			if _, _, ok := session.startInstall(); ok {
				installed.Add(1)
			}
			_ = session.snapshot()
		})
	}
	group.Wait()
	if installed.Load() != 1 {
		t.Fatalf("started %d concurrent installations", installed.Load())
	}
	session.installFailed("restart unavailable; reopen manually", false)
	if _, _, ok := session.startInstall(); ok {
		t.Fatal("a restart failure offered another installation")
	}
}
