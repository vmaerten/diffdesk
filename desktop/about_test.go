package main

import "testing"

func TestOpenLinkRefusesUnknownNames(t *testing.T) {
	d := &desktopApp{}
	if err := d.OpenLink("sponsor"); err != nil {
		t.Fatalf("known link: %v", err)
	}
	if err := d.OpenLink("https://example.com"); err == nil {
		t.Fatal("a URL from the page was accepted")
	}
}
