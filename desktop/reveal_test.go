package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInsideCheckout(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{filepath.Join(root, "src", "main.go"), filepath.Join(outside, "secret")} {
		if err := os.WriteFile(file, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}

	if target, err := insideCheckout(root, "src/main.go"); err != nil || filepath.Base(target) != "main.go" {
		t.Fatalf("file in the checkout: got %q, %v", target, err)
	}
	for _, rel := range []string{"", "../" + filepath.Base(outside) + "/secret", filepath.Join(outside, "secret"), "link", "."} {
		if target, err := insideCheckout(root, rel); err == nil {
			t.Errorf("%q resolved to %q", rel, target)
		}
	}
}
