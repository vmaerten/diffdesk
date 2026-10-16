package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestBrowserReceivesOneLiteralURL(t *testing.T) {
	var command string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
	case "linux":
		command = "xdg-open"
	default:
		t.Skip("no desktop URL handler for this platform")
	}
	directory := t.TempDir()
	received := filepath.Join(directory, "received")
	// A fake URL handler exercises actual process arguments without opening a browser.
	script := "#!/bin/sh\n[ \"$#\" -eq 1 ] || exit 2\nprintf '%s' \"$1\" > \"$GHL_TEST_BROWSER_ARGS\"\n"
	if err := os.WriteFile(filepath.Join(directory, command), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", directory)
	t.Setenv("GHL_TEST_BROWSER_ARGS", received)
	address := "http://localhost:7777/r/repo?base=main&target=$(exit 7); literal"
	if err := openBrowser(context.Background(), address); err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(received)
	if err != nil || string(actual) != address {
		t.Fatalf("URL was changed or split: %q %v", actual, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := openBrowser(ctx, address); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled opening was not cancelled: %v", err)
	}
	if err := os.Remove(filepath.Join(directory, command)); err != nil {
		t.Fatal(err)
	}
	if err := openBrowser(context.Background(), address); err == nil {
		t.Fatal("missing URL handler was not reported")
	}
}
