package main

import (
	"fmt"

	"github.com/vmaerten/diffdesk/internal/app"
)

// links are the pages the About pane, the Help menu and the palette open in the
// browser. The page names one rather than passing a URL, so it opens nothing else.
var links = map[string]string{
	"website":       "https://diffdesk.vmaerten.fr/",
	"release-notes": "https://github.com/vmaerten/diffdesk/releases",
	"report-issue":  "https://github.com/vmaerten/diffdesk/issues/new",
	"source":        "https://github.com/vmaerten/diffdesk",
	"author":        "https://github.com/vmaerten",
	"sponsor":       "https://github.com/sponsors/vmaerten",
	"buy-coffee":    "https://buymeacoffee.com/vmaerten",
}

func (d *desktopApp) OpenLink(name string) error {
	url, ok := links[name]
	if !ok {
		return fmt.Errorf("unknown link %q", name)
	}
	native, _ := d.native()
	if native == nil {
		return nil
	}
	return native.Browser.OpenURL(url)
}

// OpenAbout is About Diffdesk for the command palette, which the menu calls directly.
func (d *desktopApp) OpenAbout() { d.openSettingsPane("about") }

func (d *desktopApp) Build() app.BuildInfo { return app.Build() }
