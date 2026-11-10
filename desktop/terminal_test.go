package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTerminalCommandsAnswerWithoutTheApp(t *testing.T) {
	ctx := context.Background()
	repo := fixtureRepo(t, "terminal")
	var out, errOut bytes.Buffer
	handled, err := runTerminal(ctx, []string{"comments", "--repo", repo, "--json", "--base", "HEAD"}, "/tmp", &out, &errOut)
	var export struct{ Comments []any }
	if !handled || err != nil || json.Unmarshal(out.Bytes(), &export) != nil || export.Comments == nil {
		t.Fatalf("comments: handled=%v err=%v out=%q stderr=%q", handled, err, out.String(), errOut.String())
	}
	out.Reset()
	handled, err = runTerminal(ctx, []string{"--version", "--json"}, "/tmp", &out, &errOut)
	var info struct{ Version string }
	if !handled || err != nil || json.Unmarshal(out.Bytes(), &info) != nil || info.Version == "" {
		t.Fatalf("version: handled=%v err=%v out=%q", handled, err, out.String())
	}
	if handled, err := runTerminal(ctx, []string{"comments", "--bogus"}, "/tmp", &out, &errOut); !handled || err == nil {
		t.Fatalf("bad comments option: handled=%v err=%v", handled, err)
	}
	if handled, _ := runTerminal(ctx, []string{"--repo", repo, "feature"}, "/tmp", &out, &errOut); handled {
		t.Fatal("a review request was answered in the terminal")
	}
}

func TestResolveFromTheTerminal(t *testing.T) {
	ctx := context.Background()
	repo := fixtureRepo(t, "resolve")
	state := `{"version":1,"viewed":{},"comments":[{"id":"c0ffee00-1","path":"hello.txt","side":"additions","start":1,"end":1,"body":"Say hello","anchor":["after"],"range":"main..main","branch":"main","createdAt":"t"}]}`
	if err := os.MkdirAll(filepath.Join(repo, ".git", "ghl"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, ".git", "ghl", "state.json"), []byte(state), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		_, err := runTerminal(ctx, append([]string{"comments"}, args...), "/tmp", &out, &errOut)
		return out.String(), err
	}
	if out, err := run("resolve", "c0ffee", "--repo", repo); err != nil || out != "c0ffee00 resolved\n" {
		t.Fatalf("resolve: %v %q", err, out)
	}
	if out, err := run("--repo", repo, "--base", "HEAD"); err != nil || !strings.HasPrefix(out, "No comments") {
		t.Fatalf("a resolved comment is still exported: %v\n%s", err, out)
	}
	if out, err := run("--all", "--repo", repo, "--base", "HEAD"); err != nil || !strings.Contains(out, "c0ffee00 hello.txt:1 · resolved\nSay hello\n") {
		t.Fatalf("--all leaves the resolved comment out: %v\n%s", err, out)
	}
	if out, err := run("reopen", "c0ffee00", "--repo", repo); err != nil || out != "c0ffee00 open\n" {
		t.Fatalf("reopen: %v %q", err, out)
	}
	if out, err := run("--code", "--repo", repo, "--base", "HEAD"); err != nil || !strings.Contains(out, "Say hello\ncode:\n  after\n") {
		t.Fatalf("--code leaves the current lines out: %v\n%s", err, out)
	}
	if _, err := run("resolve", "--repo", repo); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("resolve without an ID: %v", err)
	}
}

func TestWalkthroughFromTheTerminal(t *testing.T) {
	ctx := context.Background()
	repo := fixtureRepo(t, "walkthrough")
	cwd := t.TempDir()
	document := `{"version":1,"title":"Tour","chapters":[{"title":"Greeting","stops":[{"title":"Hello","summary":"The word changes.","hunks":["hello.txt#1"]}]}]}`
	if err := os.WriteFile(filepath.Join(cwd, "tour.json"), []byte(document), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		_, err := runTerminal(ctx, append([]string{"walkthrough"}, args...), cwd, &out, &errOut)
		return out.String(), err
	}
	if out, err := run("hunks", "--repo", repo, "--base", "HEAD"); err != nil || !strings.Contains(out, "hello.txt#1  +1 -1  @@ -1 +1 @@\n") {
		t.Fatalf("hunks: %v %q", err, out)
	}
	// The document is set's first positional argument, wherever the options sit.
	if out, err := run("set", "--repo", repo, "tour.json", "--base", "HEAD"); err != nil || !strings.HasPrefix(out, "Walkthrough saved for main") {
		t.Fatalf("set: %v %q", err, out)
	}
	if out, err := run("show", "--repo", repo, "--base", "HEAD"); err != nil || !strings.Contains(out, "1.1 Hello") {
		t.Fatalf("show: %v %q", err, out)
	}
	if out, err := run("guide"); err != nil || !strings.HasPrefix(out, "# Writing a Diffdesk walkthrough") {
		t.Fatalf("guide: %v %q", err, out)
	}
	for _, args := range [][]string{{"set", "--repo", repo}, {"show", "--json", "--repo", repo}, {"tour"}, {}} {
		if _, err := run(args...); err == nil {
			t.Errorf("%v was accepted", args)
		}
	}
}
