package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

static void compactToolbar(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		for (NSWindow *window in [NSApp windows]) {
			if (window.toolbar != nil) {
				window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
			}
		}
	});
}
*/
import "C"

// compactToolbar gives the window the 38 px compact toolbar, where macOS centres
// the window buttons on the title bar. Wails v2 creates the toolbar but has no
// option for its style.
func compactToolbar() { C.compactToolbar() }
