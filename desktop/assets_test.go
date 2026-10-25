package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestDesktopAssetsServeEachWindowsDocument(t *testing.T) {
	assets := fstest.MapFS{"index.html": {Data: []byte("<html><head></head><body></body></html>")}}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) })
	handler, err := desktopAssets(assets, next, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/", "/r/repo-1234567/", "/settings"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "/desktop-native.js") {
			t.Errorf("%s: %d %q", path, response.Code, response.Body.String())
		}
	}
}
