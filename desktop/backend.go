package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vmaerten/ghl/internal/app"
)

type reviewBackend struct {
	port   int
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
}

// Serve the review runtime in this process, on a private loopback port.
func startBackend(ctx context.Context, assets fs.FS) (*reviewBackend, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("server startup failed: %w", err)
	}
	ctx, cancel := context.WithCancel(ctx)
	backend := &reviewBackend{port: listener.Addr().(*net.TCPAddr).Port, cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(backend.done)
		if err := app.NewRuntime(assets).Serve(ctx, listener); err != nil {
			fmt.Fprintln(os.Stderr, "ghl: review server stopped:", err)
		}
	}()
	return backend, nil
}

func (b *reviewBackend) close() {
	b.once.Do(func() {
		b.cancel()
		select {
		case <-b.done:
		case <-time.After(6 * time.Second):
		}
	})
}

// open registers the repository and returns its review route and checkout.
func (b *reviewBackend) open(ctx context.Context, request launch) (route, checkout string, err error) {
	client := &http.Client{Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	payload, _ := json.Marshal(map[string]string{"repoPath": request.repo})
	response, err := b.call(ctx, client, "POST", "/api/repos", bytes.NewReader(payload))
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	var registered struct{ ID, Path string }
	if err := json.NewDecoder(response.Body).Decode(&registered); err != nil {
		return "", "", err
	}
	if registered.ID == "" {
		return "", "", fmt.Errorf("missing repository identity")
	}
	query := url.Values{}
	if request.base != "" {
		query.Set("base", request.base)
	}
	if request.target != "" {
		query.Set("target", request.target)
	}
	prefix := "/r/" + url.PathEscape(registered.ID)
	selection := optionalQuery(query.Encode())
	// Validate with the runtime's existing comparison rules before replacing the
	// current review. No daemon/client launcher and no executable-hash race on rebuild.
	response, err = b.call(ctx, client, "GET", prefix+"/api/diff"+selection, nil)
	if err != nil {
		return "", "", err
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		return "", "", err
	}
	return prefix + "/" + selection, registered.Path, nil
}

// call returns the runtime's error text as the error for any non-200 reply.
func (b *reviewBackend) call(ctx context.Context, client *http.Client, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, fmt.Sprintf("http://127.0.0.1:%d%s", b.port, path), body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != 200 {
		defer response.Body.Close()
		text, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		var reply struct{ Error string }
		if json.Unmarshal(text, &reply) != nil || reply.Error == "" {
			reply.Error = strings.TrimSpace(string(text))
		}
		return nil, errors.New(reply.Error)
	}
	return response, nil
}

func optionalQuery(query string) string {
	if query == "" {
		return ""
	}
	return "?" + query
}

func (b *reviewBackend) handler() http.Handler {
	target, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(b.port))
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			// The handler is available only through Wails' private asset protocol.
			// Translate its verified origin; public runtime Host/Origin checks stay intact.
			if r.In.Header.Get("Origin") != "" {
				r.Out.Header.Set("Origin", target.String())
			}
		},
		Transport: &http.Transport{Proxy: nil},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if len(r.Header.Values("Origin")) > 1 || (origin != "" && origin != "null" && origin != "wails://wails") {
			http.Error(w, "unexpected desktop origin", http.StatusForbidden)
			return
		}
		proxy.ServeHTTP(w, r)
	})
}
