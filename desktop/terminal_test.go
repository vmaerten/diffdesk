package main

import (
	"bytes"
	"context"
	"encoding/json"
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
