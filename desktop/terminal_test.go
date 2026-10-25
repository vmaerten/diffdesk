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
	if out, err := run("--all", "--repo", repo, "--base", "HEAD"); err != nil || !strings.Contains(out, "**L1** · c0ffee00 · resolved") {
		t.Fatalf("--all leaves the resolved comment out: %v\n%s", err, out)
	}
	if out, err := run("reopen", "c0ffee00", "--repo", repo); err != nil || out != "c0ffee00 open\n" {
		t.Fatalf("reopen: %v %q", err, out)
	}
	if _, err := run("resolve", "--repo", repo); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("resolve without an ID: %v", err)
	}
}
