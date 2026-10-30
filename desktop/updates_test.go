package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestLatestUpdate(t *testing.T) {
	for _, test := range []struct {
		name, current, tag, want string
		draft, prerelease        bool
	}{
		{name: "new patch", current: "0.6.0", tag: "v0.6.1", want: "0.6.1"},
		{name: "numeric minor", current: "0.9.0", tag: "v0.10.0", want: "0.10.0"},
		{name: "numeric major", current: "9.99.99", tag: "v10.0.0", want: "10.0.0"},
		{name: "same", current: "0.6.0", tag: "v0.6.0"},
		{name: "older", current: "0.6.0", tag: "v0.5.9"},
		{name: "draft", current: "0.6.0", tag: "v0.7.0", draft: true},
		{name: "prerelease flag", current: "0.6.0", tag: "v0.7.0", prerelease: true},
		{name: "prerelease tag", current: "0.6.0", tag: "v0.7.0-beta.1"},
		{name: "invalid tag", current: "0.6.0", tag: "v00.7.0"},
		{name: "overflow", current: "0.6.0", tag: "v9999999999999999999999.0.0"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("User-Agent") != "Diffdesk/"+test.current || r.Header.Get("Accept") != "application/vnd.github+json" {
					t.Error("missing GitHub request headers")
				}
				fmt.Fprintf(w, `{"tag_name":%q,"draft":%t,"prerelease":%t,"assets":[{"name":%q}]}`, test.tag, test.draft, test.prerelease, "diffdesk_"+strings.TrimPrefix(test.tag, "v")+"_darwin_arm64.zip")
			}))
			defer server.Close()
			got, err := latestUpdate(context.Background(), server.Client(), server.URL, test.current)
			if err != nil || got.Version != test.want {
				t.Fatalf("got %q, %v; want %q", got.Version, err, test.want)
			}
		})
	}
}

func TestLatestUpdateFailuresAndCancellation(t *testing.T) {
	for _, test := range []struct {
		name, body string
		status     int
		wantError  bool
	}{
		{"rate limited", "", 403, true},
		{"offline upstream", "", 503, true},
		{"no releases", "", 404, false},
		{"bad JSON", "not JSON", 200, true},
		{"oversized", strings.Repeat(" ", (1<<20)+1), 200, true},
		{"missing archive", `{"tag_name":"v0.7.0","assets":[{"name":"other.zip"}]}`, 200, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			version, err := latestUpdate(context.Background(), server.Client(), server.URL, "0.6.0")
			if (err != nil) != test.wantError || version.Version != "" {
				t.Fatalf("got %q, %v", version, err)
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := latestUpdate(ctx, http.DefaultClient, latestReleaseURL, "0.6.0"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled check: %v", err)
	}
	for _, version := range []string{"dev", "0.6.1-beta.1", "unknown"} {
		if _, err := latestUpdate(context.Background(), nil, "", version); err == nil {
			t.Errorf("development build %q made a request", version)
		}
	}
}

func TestLatestUpdateCarriesReleaseNotes(t *testing.T) {
	for _, notes := range []string{"### Features\n\n- Read **what changed** before updating.", "", "Nouveautés : révision des fichiers 日本語"} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprintf(w, `{"tag_name":"v0.7.0","body":%q,"assets":[{"name":"diffdesk_0.7.0_darwin_arm64.zip"}]}`, notes)
		}))
		release, err := latestUpdate(context.Background(), server.Client(), server.URL, "0.6.0")
		server.Close()
		if err != nil || release.Version != "0.7.0" || release.Notes != notes {
			t.Fatalf("release notes: %+v, %v", release, err)
		}
	}
}

func TestDetectUpdateInstallationOwnsExactBundle(t *testing.T) {
	root := t.TempDir()
	brewRoot := filepath.Join(root, "Caskroom")
	miseRoot := filepath.Join(root, "mise", "diffdesk", "0.6.0")
	legacyRoot := filepath.Join(root, "mise", "ghl", "0.6.0")
	brewBundle := filepath.Join(root, "Applications", "Diffdesk.app")
	miseBundle := filepath.Join(miseRoot, "Diffdesk.app")
	legacyBundle := filepath.Join(legacyRoot, "Diffdesk.app")
	sourceBundle := filepath.Join(root, "source", "Diffdesk.app")
	for _, path := range []string{brewBundle, miseBundle, legacyBundle, sourceBundle, filepath.Join(brewRoot, "diffdesk", "0.6.0")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(brewBundle, filepath.Join(brewRoot, "diffdesk", "0.6.0", "Diffdesk.app")); err != nil {
		t.Fatal(err)
	}
	run := func(_ context.Context, executable string, args ...string) ([]byte, error) {
		if executable == "brew" && reflect.DeepEqual(args, []string{"--caskroom"}) {
			return []byte(brewRoot + "\n"), nil
		}
		if executable == "mise" && reflect.DeepEqual(args, []string{"where", "github:vmaerten/diffdesk@0.6.0"}) {
			return []byte(miseRoot + "\n"), nil
		}
		if executable == "mise" && reflect.DeepEqual(args, []string{"where", "github:vmaerten/ghl@0.6.0"}) {
			return []byte(legacyRoot + "\n"), nil
		}
		t.Fatalf("unexpected detection command %s %v", executable, args)
		return nil, nil
	}
	for _, test := range []struct{ bundle, manager, tool string }{
		{brewBundle, "Homebrew", ""}, {miseBundle, "mise", miseTool}, {legacyBundle, "mise", legacyMiseTool}, {sourceBundle, "", ""},
	} {
		installation, err := detectUpdateInstallation(context.Background(), test.bundle, "0.6.0", "brew", "mise", run)
		if installation.manager != test.manager || installation.tool != test.tool || (err != nil) != (test.manager == "") {
			t.Fatalf("%s: %+v, %v", test.bundle, installation, err)
		}
	}
}

func TestInstallUpdateVerifiesVersionBeforeRestart(t *testing.T) {
	for _, owner := range []struct{ manager, tool string }{{"Homebrew", ""}, {"mise", miseTool}, {"mise", legacyMiseTool}} {
		manager := owner.manager
		for _, version := range []string{"0.6.0", "0.7.0", "0.8.0", "dev", "invalid JSON"} {
			t.Run(manager+owner.tool+"/"+version, func(t *testing.T) {
				var calls [][]string
				run := func(_ context.Context, executable string, args ...string) ([]byte, error) {
					calls = append(calls, append([]string{executable}, args...))
					if executable == "/new/Diffdesk.app/Contents/MacOS/diffdesk" || executable == "/old/Diffdesk.app/Contents/MacOS/diffdesk" {
						if version == "invalid JSON" {
							return []byte("oops"), nil
						}
						return []byte(fmt.Sprintf(`{"version":%q}`, version)), nil
					}
					if args[0] == "where" {
						return []byte("/new\n"), nil
					}
					return nil, nil
				}
				installation := updateInstallation{manager, "manager", "/old/Diffdesk.app", owner.tool}
				bundle, err := installation.install(context.Background(), "0.7.0", run)
				want := "/old/Diffdesk.app"
				if manager == "mise" {
					want = "/new/Diffdesk.app"
				}
				if version != "0.7.0" && version != "0.8.0" {
					if err == nil || bundle != "" {
						t.Fatalf("unverified installation would restart: %q %v", bundle, err)
					}
				} else if err != nil || bundle != want {
					t.Fatalf("verified installation: %q %v", bundle, err)
				}
				var expected [][]string
				if manager == "Homebrew" {
					expected = [][]string{{"manager", "upgrade", "--cask", "vmaerten/tap/diffdesk"}}
				} else {
					expected = [][]string{{"manager", "use", "--global", "--fuzzy", "--minimum-release-age", "0s", "--yes", "github:vmaerten/diffdesk@latest"}, {"manager", "where", "github:vmaerten/diffdesk@latest"}}
				}
				expected = append(expected, []string{want + "/Contents/MacOS/diffdesk", "--version", "--json"})
				// The old name leaves the config only once the new install is verified.
				if owner.tool == legacyMiseTool && (version == "0.7.0" || version == "0.8.0") {
					expected = append(expected, []string{"manager", "unuse", "--global", "--no-prune", "--yes", "github:vmaerten/ghl"})
				}
				if !reflect.DeepEqual(calls, expected) {
					t.Fatalf("commands = %v; want %v", calls, expected)
				}
			})
		}
	}
}

func TestInstallUpdateStopsOnManagerFailure(t *testing.T) {
	for _, manager := range []string{"Homebrew", "mise"} {
		calls := 0
		run := func(context.Context, string, ...string) ([]byte, error) {
			calls++
			return nil, errors.New("installation failed")
		}
		bundle, err := (updateInstallation{manager, "manager", "/app", legacyMiseTool}).install(context.Background(), "0.7.0", run)
		if bundle != "" || err == nil || calls != 1 {
			t.Fatalf("%s: bundle=%q err=%v calls=%d", manager, bundle, err, calls)
		}
		calls = 0
		if _, err := (updateInstallation{manager, "manager", "/app", legacyMiseTool}).install(context.Background(), "0.7.0; touch /tmp/no", run); err == nil || calls != 0 {
			t.Fatal("invalid version reached the package manager")
		}
	}
}

func TestMiseUpdaterCommandAcceptsPinnedCLI(t *testing.T) {
	mise := os.Getenv("DIFFDESK_TEST_MISE")
	if mise == "" {
		t.Skip("set DIFFDESK_TEST_MISE to the pinned release-acceptance mise binary")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := func(ctx context.Context, executable string, args ...string) ([]byte, error) {
		if executable == mise {
			if args[0] == "where" {
				return []byte("/fixture\n"), nil
			}
			// Exercise the real CLI parser, without installing anything or changing
			// the user's mise configuration. Lookup and version verification are fixtures.
			return runUpdateCommand(ctx, executable, append(args, "--help")...)
		}
		return []byte(`{"version":"0.7.0"}`), nil
	}
	if _, err := (updateInstallation{"mise", mise, "/fixture/Diffdesk.app", legacyMiseTool}).install(ctx, "0.7.0", run); err != nil {
		t.Fatalf("the updater command is incompatible with the acceptance CLI: %v", err)
	}
}

func TestUpdateCommandsBoundOutputAndHonorCancellation(t *testing.T) {
	var output updateOutput
	payload := strings.Repeat("x", 40*1024)
	if n, err := output.Write([]byte(payload)); n != len(payload) || err != nil || len(output.data) != 32*1024 {
		t.Fatalf("bounded output: %d %v %d", n, err, len(output.data))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := runUpdateCommand(ctx, "/bin/sleep", "30"); err == nil || ctx.Err() == nil {
		t.Fatalf("command ignored cancellation: %v", err)
	}
	if _, err := runUpdateCommand(context.Background(), "/bin/sh", "-c", "echo fixture-error >&2; exit 1"); err == nil || !strings.Contains(err.Error(), "fixture-error") {
		t.Fatalf("missing manager failure output: %v", err)
	}
}

func TestUpdateRestartPreservesActiveComparisonAsArguments(t *testing.T) {
	state := tabSnapshot{Active: "2", Tabs: []reviewTab{
		{ID: "1", checkout: "/other", Route: "/r/other?base=main"},
		{ID: "2", checkout: "/repo with 'quotes' and $(touch nope)", Route: "/r/active?base=main&target=feature%2F%C3%A9"},
	}}
	bundle := "/Apps with spaces/Diffdesk.app"
	command := updateRestartCommand(42, bundle, state)
	want := []string{"diffdesk-update", "42", bundle, "--args", "--desktop-window", "--repo", state.Tabs[1].checkout, "--base", "main", "feature/é"}
	if !reflect.DeepEqual(command.Args[3:], want) || strings.Contains(command.Args[2], state.Tabs[1].checkout) {
		t.Fatalf("restart arguments: %q", command.Args)
	}
	if !command.SysProcAttr.Setsid || command.Dir != "/" {
		t.Fatal("restart helper is not detached from the app")
	}
	if got := updateRestartCommand(42, bundle, tabSnapshot{}).Args[3:]; !reflect.DeepEqual(got, want[:5]) {
		t.Fatalf("welcome screen restart: %q", got)
	}
}

func TestUpdateCheckDoesNotStartWhenBusyOrShuttingDown(t *testing.T) {
	u := nativeUpdater{ctx: context.Background()}
	u.session.busy = true
	u.check(true) // No native application: starting a check here would panic.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	u.ctx = ctx
	u.session.busy = false
	u.check(false)
	if u.session.busy {
		t.Fatal("shutdown started an update check")
	}
}

func TestUpdateSchedule(t *testing.T) {
	paris, err := time.LoadLocation("Europe/Paris")
	if err != nil {
		t.Fatal(err)
	}
	tokyo, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	at := func(month time.Month, day, hour, minute int, zone *time.Location) time.Time {
		return time.Date(2026, month, day, hour, minute, 0, 0, zone)
	}
	for _, test := range []struct {
		name    string
		checked time.Time
		retry   bool
		now     time.Time
		want    bool
	}{
		{name: "launched before 10:00", checked: at(10, 30, 8, 0, paris), now: at(10, 30, 9, 59, paris)},
		{name: "10:00 after a morning launch", checked: at(10, 30, 8, 0, paris), now: at(10, 30, 10, 0, paris), want: true},
		{name: "launched after 10:00", checked: at(10, 30, 11, 0, paris), now: at(10, 30, 23, 0, paris)},
		{name: "next day before 10:00", checked: at(10, 30, 11, 0, paris), now: at(10, 31, 9, 0, paris)},
		{name: "next day at 10:00", checked: at(10, 30, 11, 0, paris), now: at(10, 31, 10, 0, paris), want: true},
		{name: "wake after a missed 10:00", checked: at(10, 28, 18, 0, paris), now: at(10, 30, 14, 0, paris), want: true},
		{name: "10:00 after the switch to winter time", checked: at(10, 24, 11, 0, paris), now: at(10, 25, 10, 0, paris), want: true},
		{name: "10:00 in the new time zone", checked: at(10, 30, 11, 0, paris), now: at(10, 31, 10, 0, tokyo), want: true},
		{name: "before 10:00 in the new time zone", checked: at(10, 30, 11, 0, paris), now: at(10, 31, 9, 0, tokyo)},
		{name: "failed check retried later", checked: at(10, 30, 10, 0, paris), retry: true, now: at(10, 30, 10, 15, paris), want: true},
		{name: "failed check not retried at once", checked: at(10, 30, 10, 0, paris), retry: true, now: at(10, 30, 10, 14, paris)},
	} {
		t.Run(test.name, func(t *testing.T) {
			var schedule updateSchedule
			schedule.started(test.checked)
			schedule.finished(test.checked, test.retry)
			if got := schedule.due(test.now); got != test.want {
				t.Fatalf("due = %t, want %t", got, test.want)
			}
		})
	}
}
