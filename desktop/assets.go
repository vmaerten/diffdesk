package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed native.js
var nativeScript string

// desktopAssets loads the host interface before React on every page load. Wails
// serves its matching runtime at /wails/runtime.js; the rest goes to next.
// compact marks the page for the window's 38 px title bar from its first paint.
func desktopAssets(assets fs.FS, next http.Handler, compact bool) (http.Handler, error) {
	index, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(index, []byte("<head>")) {
		return nil, fmt.Errorf("desktop index.html is missing its head element")
	}
	index = bytes.Replace(index, []byte("<head>"), []byte(`<head><script type="module" src="/desktop-native.js"></script>`), 1)
	if compact {
		index = bytes.Replace(index, []byte("<html"), []byte(`<html data-titlebar="compact"`), 1)
	}
	script := []byte(nativeScript + "\n" + bridge)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		switch {
		case r.Method == "GET" && r.URL.Path == "/desktop-native.js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(script)
		case r.Method == "GET" && (r.URL.Path == "/" || r.URL.Path == "/settings" || (len(parts) == 2 && parts[0] == "r")):
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(index)
		default:
			next.ServeHTTP(w, r)
		}
	}), nil
}
