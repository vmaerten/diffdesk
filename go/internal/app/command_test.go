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
		{[]string{"--help"}, 0},
		{[]string{"--unknown"}, 1},
		{[]string{"--port", "-1"}, 1},
		{[]string{"--port", "65536"}, 1},
		{[]string{"extra"}, 1},
	} {
		var stdout, stderr bytes.Buffer
		if code := Main(context.Background(), test.args, &stdout, &stderr, Options{}); code != test.code || stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatalf("%v: code=%d stdout=%s stderr=%s", test.args, code, stdout.String(), stderr.String())
		}
	}
}
