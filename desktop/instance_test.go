package main

import (
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

// shortDir keeps socket paths under macOS's 104-byte limit, which t.TempDir can exceed.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "ghl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// The launcher and the app LaunchServices starts must agree on the folder
// whatever TMPDIR each of them was given.
func TestUserTempDirIgnoresTMPDIR(t *testing.T) {
	want := userTempDir()
	t.Setenv("TMPDIR", t.TempDir())
	if got := userTempDir(); got != want || got == os.TempDir() {
		t.Fatalf("user temp dir %q follows TMPDIR %q", got, os.TempDir())
	}
}

func TestOneAppClaimsTheInstance(t *testing.T) {
	dir := shortDir(t)
	first, err := claimInstance(dir, "app")
	if err != nil || first == nil {
		t.Fatalf("first claim: %v, %v", first, err)
	}
	if second, err := claimInstance(dir, "app"); err != nil || second != nil {
		t.Fatalf("second claim while the first runs: %v, %v", second, err)
	}
	first.close()
	if third, err := claimInstance(dir, "app"); err != nil || third == nil {
		t.Fatalf("claim after the app quit: %v, %v", third, err)
	} else {
		// The quitting app closes again from its deferred cleanup.
		first.close()
		if _, err := os.Stat(third.socket); err != nil {
			t.Fatalf("next app's socket removed: %v", err)
		}
		third.close()
	}
}

func TestDeliveryDuringStartupWaitsForTheApp(t *testing.T) {
	dir := shortDir(t)
	received := make(chan launch, 1)
	go func() {
		// The app comes up after the launcher started waiting, as on a cold start.
		time.Sleep(300 * time.Millisecond)
		owner, err := claimInstance(dir, "app")
		if err != nil || owner == nil {
			t.Errorf("claim: %v, %v", owner, err)
			return
		}
		t.Cleanup(owner.close)
		owner.serve(func(request launch) error { received <- request; return nil })
	}()
	request := launch{repo: "/tmp/review", base: "main", target: "feature"}
	if err := deliver(dir, "app", request, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if got := <-received; got != request {
		t.Fatalf("delivered %+v, want %+v", got, request)
	}
}

func TestDeliveryReportsTheAppsRefusalAndAMissingApp(t *testing.T) {
	dir := shortDir(t)
	if err := deliver(dir, "app", launch{repo: "/tmp/review"}, 0); !errors.Is(err, errNoApp) {
		t.Fatalf("without an app: %v", err)
	}
	owner, err := claimInstance(dir, "app")
	if err != nil || owner == nil {
		t.Fatal(err)
	}
	defer owner.close()
	go owner.serve(func(launch) error { return errors.New("too many pending openings; retry") })
	if err := deliver(dir, "app", launch{repo: "/tmp/review"}, 0); err == nil || err.Error() != "too many pending openings; retry" {
		t.Fatalf("refusal: %v", err)
	}
}

func TestStaleSocketDoesNotBlockTheNextApp(t *testing.T) {
	dir := shortDir(t)
	_, socketPath := instancePaths(dir, "app")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	// A crash leaves the socket file behind with nobody accepting on it.
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	listener.Close()
	owner, err := claimInstance(dir, "app")
	if err != nil || owner == nil {
		t.Fatalf("claim over a stale socket: %v, %v", owner, err)
	}
	owner.close()
}
