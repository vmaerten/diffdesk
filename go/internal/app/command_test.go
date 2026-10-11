package app

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestVersionDoesNotRequireGitRepositoryOrAssets(t *testing.T) {
	t.Setenv("PATH", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, poc := range []bool{false, true} {
		var stdout, stderr bytes.Buffer
		opts := Options{PoC: poc}
		code := Main(ctx, []string{"--version", "--json", "--repo", "/missing"}, &stdout, &stderr, opts)
		var info BuildInfo
		if err := json.Unmarshal(stdout.Bytes(), &info); err != nil {
			t.Fatal(err)
		}
		if code != 0 || info != buildInfo() || stderr.Len() != 0 {
			t.Fatalf("version started runtime or lost metadata: %d %s %s", code, stdout.String(), stderr.String())
		}
		stdout.Reset()
		if code := Main(ctx, []string{"--version"}, &stdout, &stderr, opts); code != 0 || !strings.HasPrefix(stdout.String(), opts.name()+" ") {
			t.Fatalf("wrong command identity: %s", stdout.String())
		}
	}
}

func TestCommandHelpAndInvalidArgumentsDoNotAnnounceReadiness(t *testing.T) {
	t.Setenv("PATH", "")
	for _, test := range []struct {
		args []string
		code int
	}{
		{[]string{"--unknown"}, 1},
		{[]string{"--port", "-1"}, 1},
		{[]string{"--port", "65536"}, 1},
	} {
		var stdout, stderr bytes.Buffer
		if code := Main(context.Background(), test.args, &stdout, &stderr, Options{}); code != test.code || stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatalf("%v: code=%d stdout=%s stderr=%s", test.args, code, stdout.String(), stderr.String())
		}
	}
}

func TestHelpUsesStdoutWithoutGitOrAssets(t *testing.T) {
	t.Setenv("PATH", "")
	t.Setenv("GHL_PORT", "")
	for _, args := range [][]string{{"--help"}, {"-h"}, {"comments", "feature", "--help"}} {
		var stdout, stderr bytes.Buffer
		if code := Main(context.Background(), args, &stdout, &stderr, Options{}); code != 0 || stdout.String() != commandHelp || stderr.Len() != 0 {
			t.Fatalf("%v: code=%d stdout=%s stderr=%s", args, code, stdout.String(), stderr.String())
		}
	}
	var stdout, stderr bytes.Buffer
	if code := Main(context.Background(), []string{"--help"}, &stdout, &stderr, Options{PoC: true}); code != 0 || stdout.Len() != 0 || stderr.Len() == 0 {
		t.Fatal("PoC flag help changed")
	}
}

func TestCommandParsing(t *testing.T) {
	t.Setenv("GHL_PORT", "12345")
	for _, args := range [][]string{
		{"comments", "feature", "--base", "main", "--json", "--print", "--no-daemon"},
		{"comments", "--base", "main", "feature", "--print", "--json", "--no-daemon"},
		{"comments", "--json", "--base=main", "--no-daemon", "--print", "feature"},
	} {
		cli, err := parseCommand(args, &bytes.Buffer{}, Options{})
		if err != nil || cli.target != "feature" || cli.base != "main" || !cli.comments || !cli.json || !cli.print || cli.port != 12345 {
			t.Fatalf("%v: %+v %v", args, cli, err)
		}
	}
	cli, err := parseCommand([]string{"refs/heads/comments", "--port", "0"}, &bytes.Buffer{}, Options{})
	if err != nil || cli.comments || cli.target != "refs/heads/comments" || cli.port != 0 {
		t.Fatalf("branch escape or explicit port lost: %+v %v", cli, err)
	}
	cli, err = parseCommand(nil, &bytes.Buffer{}, Options{PoC: true})
	if err != nil || cli.port != 0 || cli.base != "HEAD" {
		t.Fatal("production environment leaked into PoC")
	}
	cli, err = parseCommand([]string{"--port", "0123"}, &bytes.Buffer{}, Options{})
	if err != nil || cli.port != 123 {
		t.Fatalf("port was interpreted as octal: %+v %v", cli, err)
	}
	for _, args := range [][]string{
		{"one", "two"}, {"--unknown"}, {"--port", "12oops"}, {"--base"}, {"--base", "--print"},
		{"--repo"}, {"--port"}, {"--port", "-1"}, {"--port=65536"}, {"--daemon"}, {"--idle", "1"},
	} {
		if _, err := parseCommand(args, &bytes.Buffer{}, Options{}); err == nil {
			t.Fatalf("accepted invalid args %v", args)
		}
	}
	t.Setenv("GHL_PORT", "oops")
	if _, err := parseCommand(nil, &bytes.Buffer{}, Options{}); err == nil || !strings.Contains(err.Error(), "GHL_PORT") {
		t.Fatalf("invalid environment: %v", err)
	}
}

func TestShortCommandsWithoutUI(t *testing.T) {
	t.Setenv("GHL_PORT", "")
	r := fixture(t)
	for _, args := range [][]string{{"--print"}, {"comments"}, {"comments", "--json", "--print"}} {
		var stdout, stderr bytes.Buffer
		full := append(args, "--repo", r.Path, "--base", "main")
		if code := Main(context.Background(), full, &stdout, &stderr, Options{}); code != 0 || stdout.Len() == 0 || stderr.Len() != 0 {
			t.Fatalf("%v requires a server/assets: %d %s %s", args, code, stdout.String(), stderr.String())
		}
		if args[0] == "comments" && args[len(args)-1] == "--print" && !strings.Contains(stdout.String(), `"comments": []`) {
			t.Fatal("comments command lost precedence over --print")
		}
	}
}
