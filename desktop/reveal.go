package main

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
)

var errOutsideCheckout = errors.New("the file is outside the reviewed checkout")

// insideCheckout resolves a repository-relative path, symlinks included, and
// refuses anything that lands outside the checkout.
func insideCheckout(root, rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", errOutsideCheckout
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(target, root+string(filepath.Separator)) {
		return "", errOutsideCheckout
	}
	return target, nil
}

// RevealInFinder selects a reviewed file in Finder. The path comes from the
// page, so it is checked against the tab's own checkout.
func (d *desktopApp) RevealInFinder(tabID, path string) error {
	root, ok := d.tabs.checkout(tabID)
	if !ok {
		return errors.New("this review is no longer open")
	}
	target, err := insideCheckout(root, path)
	if err != nil {
		return err
	}
	return exec.Command("/usr/bin/open", "-R", target).Run()
}
