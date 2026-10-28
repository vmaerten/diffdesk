package app

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestFakeLanguageServer is the server the other tests start: this test
// binary run again, speaking LSP on stdio. GHL_FAKE_LSP picks its behaviour.
func TestFakeLanguageServer(t *testing.T) {
	mode := os.Getenv("GHL_FAKE_LSP")
	if mode == "" {
		t.Skip("started by the language server tests")
	}
	if log := os.Getenv("GHL_FAKE_LSP_LOG"); log != "" {
		file, err := os.OpenFile(log, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = file.WriteString("start\n")
			file.Close()
		}
	}
	if mode == "crash" {
		fmt.Fprintln(os.Stderr, "fake: cannot load the workspace")
		os.Exit(3)
	}
	write := func(message map[string]any) {
		message["jsonrpc"] = "2.0"
		body, _ := json.Marshal(message)
		fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(body), body)
	}
	progress := func(value map[string]any) {
		write(map[string]any{"method": "$/progress", "params": map[string]any{"token": "index", "value": value}})
	}
	reader := bufio.NewReader(os.Stdin)
	var cancelled []int64
	var documents []string
	configured, watched, root := false, 0, ""
	location := func(uri string, line, character, length int) map[string]any {
		return map[string]any{"uri": uri, "range": map[string]any{"start": map[string]int{"line": line, "character": character}, "end": map[string]int{"line": line, "character": character + length}}}
	}
	for {
		body, err := readFrame(reader)
		if err != nil {
			os.Exit(0)
		}
		var message rpcMessage
		_ = json.Unmarshal(body, &message)
		switch message.Method {
		case "initialize":
			var params struct {
				RootURI string `json:"rootUri"`
			}
			_ = json.Unmarshal(message.Params, &params)
			root = params.RootURI
			write(map[string]any{"id": message.ID, "result": map[string]any{"capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "fake", "version": "1.0"}}})
		case "initialized":
			write(map[string]any{"id": "configuration", "method": "workspace/configuration", "params": map[string]any{"items": []any{map[string]string{"section": "a"}, map[string]string{"section": "b"}}}})
			if mode == "indexing" {
				write(map[string]any{"id": "progress", "method": "window/workDoneProgress/create", "params": map[string]string{"token": "index"}})
				progress(map[string]any{"kind": "begin", "title": "Indexing", "percentage": 0})
				progress(map[string]any{"kind": "report", "message": "3/7 packages", "percentage": 42})
			}
		case "$/cancelRequest":
			var params struct {
				ID int64 `json:"id"`
			}
			_ = json.Unmarshal(message.Params, &params)
			cancelled = append(cancelled, params.ID)
		case "textDocument/didOpen", "textDocument/didChange":
			var params struct {
				TextDocument struct {
					URI     string `json:"uri"`
					Version int    `json:"version"`
				} `json:"textDocument"`
			}
			_ = json.Unmarshal(message.Params, &params)
			documents = append(documents, fmt.Sprintf("%s %s v%d", message.Method, strings.TrimPrefix(params.TextDocument.URI, root+"/"), params.TextDocument.Version))
		case "workspace/didChangeWatchedFiles":
			watched++
		case "textDocument/hover":
			write(map[string]any{"id": message.ID, "result": map[string]any{"contents": map[string]string{"kind": "markdown", "value": "```go\nfunc (s *Store) Mutate()\n```\n\n---\n\nMutate changes [the state](https://pkg.go.dev/state)."}}})
		case "textDocument/definition":
			write(map[string]any{"id": message.ID, "result": []any{location(root+"/store.go", 2, 16, 6), location("file:///usr/local/go/src/context/context.go", 9, 5, 7)}})
		case "textDocument/references":
			write(map[string]any{"id": message.ID, "result": []any{location(root+"/main.go", 4, 2, 6), location(root+"/caller.go", 2, 8, 6), location("file:///elsewhere/vendor.go", 1, 0, 6)}})
		case "fake/hang":
		case "fake/state":
			write(map[string]any{"id": message.ID, "result": map[string]any{"cancelled": cancelled, "configured": configured, "documents": documents, "watched": watched}})
		case "shutdown":
			write(map[string]any{"id": message.ID, "result": nil})
		case "exit":
			os.Exit(0)
		case "":
			if string(message.ID) == `"configuration"` {
				var items []any
				configured = json.Unmarshal(message.Result, &items) == nil && len(items) == 2
			}
		default:
			if message.ID != nil {
				write(map[string]any{"id": message.ID, "error": map[string]any{"code": -32601, "message": "unknown method"}})
			}
		}
	}
}

// fakeServers serves "go" with the fake server, found on PATH as fakels.
func fakeServers(t *testing.T, mode string) (*languageServers, string, string) {
	t.Helper()
	bin := t.TempDir()
	script := "#!/bin/sh\nexec \"$GHL_FAKE_BINARY\" -test.run='^TestFakeLanguageServer$'\n"
	if err := os.WriteFile(filepath.Join(bin, "fakels"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(bin, "starts")
	m := newLanguageServers()
	m.languages = []language{{ID: "go", Label: "Go", Extensions: []string{".go"}, Installs: []installMethod{{"fake", []string{"install", "fakels"}}},
		Servers: []languageServer{{Name: "fakels", Choice: "fakels", command: "fakels"}}}}
	m.environment = func(string) []string {
		return append(os.Environ(), "PATH="+bin, "GHL_FAKE_BINARY="+os.Args[0], "GHL_FAKE_LSP="+mode, "GHL_FAKE_LSP_LOG="+log)
	}
	t.Cleanup(m.close)
	return m, t.TempDir(), log
}

func waitFor(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func goStatus(m *languageServers, root string) languageStatus {
	return m.status(root, nil).Languages[0]
}

func TestLanguageServerStartsOnDemandAndShutsDown(t *testing.T) {
	m, root, _ := fakeServers(t, "ok")
	ctx := context.Background()
	if status := goStatus(m, root); status.State != "idle" || status.Server == nil || status.Server.Origin != "PATH" || filepath.Base(status.Server.Path) != "fakels" {
		t.Fatalf("an installed server before any use: %+v", status)
	}
	if _, err := m.client(ctx, root, "go"); !errors.Is(err, errLSPDisabled) {
		t.Fatalf("started before Settings enabled it: %v", err)
	}
	if err := m.configure(lspConfig{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	client, err := m.client(ctx, root, "go")
	if err != nil {
		t.Fatal(err)
	}
	if again, err := m.client(ctx, root, "go"); err != nil || again != client {
		t.Fatalf("a second request started another server: %v", err)
	}
	if status := goStatus(m, root); status.State != "ready" || status.Version != "1.0" {
		t.Fatalf("a running server: %+v", status)
	}
	var state struct {
		Cancelled  []int64 `json:"cancelled"`
		Configured bool    `json:"configured"`
	}
	hang, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if err := client.conn.call(hang, "fake/hang", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("an abandoned request: %v", err)
	}
	if err := client.conn.call(ctx, "fake/state", nil, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Cancelled) != 1 || !state.Configured {
		t.Fatalf("the server was not told of the cancellation, or got no configuration: %+v", state)
	}
	if err := m.configure(lspConfig{Enabled: true, Servers: map[string]string{"go": "off"}}); err != nil {
		t.Fatal(err)
	}
	if !closedChannel(client.exited) || client.cmd.ProcessState.ExitCode() != 0 {
		t.Fatalf("turning the language off did not shut its server down: %v", client.cmd.ProcessState)
	}
	if status := goStatus(m, root); status.State != "off" {
		t.Fatalf("a language turned off: %+v", status)
	}
	if err := m.configure(lspConfig{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	client, err = m.client(ctx, root, "go")
	if err != nil {
		t.Fatal(err)
	}
	m.close()
	if !closedChannel(client.exited) {
		t.Fatal("closing the runtime left the server running")
	}
	if _, err := m.client(ctx, root, "go"); !errors.Is(err, errLSPClosed) {
		t.Fatalf("started after close: %v", err)
	}
}

func TestLanguageServerFailureIsRemembered(t *testing.T) {
	m, root, log := fakeServers(t, "crash")
	m.retry = 300 * time.Millisecond
	_ = m.configure(lspConfig{Enabled: true})
	starts := func() int {
		raw, _ := os.ReadFile(log)
		return strings.Count(string(raw), "start")
	}
	_, err := m.client(context.Background(), root, "go")
	if err == nil || !strings.Contains(err.Error(), "cannot load the workspace") {
		t.Fatalf("the failure lost the server's stderr: %v", err)
	}
	if _, again := m.client(context.Background(), root, "go"); again == nil || starts() != 1 {
		t.Fatalf("a failed server was started again at once: %v, %d starts", again, starts())
	}
	if status := goStatus(m, root); status.State != "failed" || !strings.Contains(status.Error, "cannot load the workspace") {
		t.Fatalf("a failed server: %+v", status)
	}
	time.Sleep(m.retry)
	_, _ = m.client(context.Background(), root, "go")
	if starts() != 2 {
		t.Fatalf("a failed server was not retried later: %d starts", starts())
	}
}

func TestLanguageServerStopsWhenIdle(t *testing.T) {
	m, root, _ := fakeServers(t, "ok")
	m.idle = 100 * time.Millisecond
	_ = m.configure(lspConfig{Enabled: true})
	client, err := m.client(context.Background(), root, "go")
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the idle stop", func() bool { return closedChannel(client.exited) })
	if status := goStatus(m, root); status.State != "idle" {
		t.Fatalf("an idle server that stopped: %+v", status)
	}
}

func TestLanguageServerReportsProgress(t *testing.T) {
	m, root, _ := fakeServers(t, "indexing")
	_ = m.configure(lspConfig{Enabled: true})
	if _, err := m.client(context.Background(), root, "go"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "progress", func() bool {
		status := goStatus(m, root)
		return status.State == "indexing" && status.Progress != nil && status.Progress.Percentage != nil && *status.Progress.Percentage == 42
	})
}

func TestMissingLanguageServerSaysHowToInstallIt(t *testing.T) {
	m, root, _ := fakeServers(t, "ok")
	m.languages[0].Servers[0].command = "absent"
	_ = m.configure(lspConfig{Enabled: true})
	if status := goStatus(m, root); status.State != "missing" || status.Server != nil || status.Install != "install fakels" {
		t.Fatalf("a missing server: %+v", status)
	}
	if _, err := m.client(context.Background(), root, "go"); err == nil || !strings.Contains(err.Error(), "install fakels") {
		t.Fatalf("a missing server: %v", err)
	}
}

func TestTypeScriptServerPreference(t *testing.T) {
	bin, root := t.TempDir(), t.TempDir()
	executable := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	typescript := func(version string) {
		t.Helper()
		writeFixture(t, root, "node_modules/typescript/package.json", `{"name":"typescript","version":"`+version+`"}`)
	}
	executable(filepath.Join(bin, "tsrs"))
	executable(filepath.Join(bin, "typescript-language-server"))
	executable(filepath.Join(root, "node_modules", ".bin", "tsc"))
	typescript("6.0.3")
	ts := defaultLanguages()[1]
	env := []string{"PATH=" + bin}
	expect := func(choice, name, origin string) {
		t.Helper()
		found := ts.find(root, env, choice)
		switch {
		case name == "" && found != nil:
			t.Fatalf("%s found %+v", choice, found)
		case name != "" && (found == nil || found.Name != name || found.Origin != origin):
			t.Fatalf("%s found %+v, expected %s from %s", choice, found, name, origin)
		}
	}
	expect("auto", "tsrs", "PATH")
	expect("tsc", "", "")
	expect("typescript-language-server", "typescript-language-server", "PATH")
	typescript("7.1.0")
	// tsrs comes first, even from PATH against the checkout's TypeScript 7.
	expect("auto", "tsrs", "PATH")
	expect("tsc", "tsc", "checkout")
	if err := os.Remove(filepath.Join(bin, "tsrs")); err != nil {
		t.Fatal(err)
	}
	expect("auto", "tsc", "checkout")
	executable(filepath.Join(root, "node_modules", ".bin", "tsrs"))
	expect("auto", "tsrs", "checkout")
	expect("off", "", "")
}

func TestPythonServerPreference(t *testing.T) {
	bin, root := t.TempDir(), t.TempDir()
	for _, path := range []string{filepath.Join(bin, "pyright-langserver"), filepath.Join(bin, "ty"), filepath.Join(root, ".venv", "bin", "basedpyright-langserver")} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	python, _ := newLanguageServers().language("python")
	env := []string{"PATH=" + bin}
	for choice, want := range map[string]string{"auto": "basedpyright checkout", "pyright": "pyright PATH", "ty": "ty PATH"} {
		found := python.find(root, env, choice)
		if found == nil || found.Name+" "+found.Origin != want {
			t.Errorf("%s found %+v, expected %s", choice, found, want)
		}
	}
	if err := os.RemoveAll(filepath.Join(root, ".venv")); err != nil {
		t.Fatal(err)
	}
	if found := python.find(root, env, "auto"); found == nil || found.Name != "pyright" {
		t.Errorf("without a virtual environment, auto found %+v", found)
	}
}

func TestLSPRoutes(t *testing.T) {
	runtime := NewRuntime(nil)
	runtime.lsp.environment = func(string) []string { return []string{"PATH=" + t.TempDir()} }
	t.Cleanup(runtime.lsp.close)
	entry, err := runtime.Open(context.Background(), fixture(t).Path)
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		runtime.ServeHTTP(w, r)
		return w
	}
	requireStatus(t, request("PUT", "/api/lsp", `{"enabled":true,"servers":{"cobol":"auto"}}`), 400)
	requireStatus(t, request("PUT", "/api/lsp", `{"enabled":true,"servers":{"go":"tsc"}}`), 400)
	requireStatus(t, request("PUT", "/api/lsp", `{"enabled":true,"servers":{"go":"off","typescript":"tsrs"}}`), 200)
	reply := request("GET", "/r/"+entry.ID+"/api/lsp", "")
	requireStatus(t, reply, 200)
	var status lspStatus
	if err := json.Unmarshal(reply.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, l := range status.Languages {
		states[l.ID+"="+l.Choice] = l.State
	}
	if !status.Enabled || states["go=off"] != "off" || states["typescript=tsrs"] != "missing" || states["rust=auto"] != "missing" {
		t.Fatalf("the status does not follow the settings: %s", reply.Body.String())
	}
	if !slices.Equal(status.Languages[1].Choices, []string{"auto", "tsrs", "tsc", "typescript-language-server", "off"}) {
		t.Fatalf("TypeScript choices: %v", status.Languages[1].Choices)
	}
}

func TestLoginEnvironmentSkipsWhatStartupFilesPrint(t *testing.T) {
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	shell := filepath.Join(dir, "shell")
	script := "#!/bin/sh\necho 'Welcome to the shell'\nexport GHL_FROM_STARTUP=yes\neval \"$4\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	env, err := loginEnvironment(shell, dir, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	// Never print env itself: it holds the developer's secrets.
	if value := environmentValue(env, "GHL_FROM_STARTUP"); value != "yes" {
		t.Fatalf("a variable set by the startup files: %q", value)
	}
	if environmentValue(env, "PATH") == "" {
		t.Fatal("the shell's environment has no PATH")
	}
	if pwd := environmentValue(env, "PWD"); pwd != dir {
		t.Fatalf("the shell ran in %q, not in the repository", pwd)
	}
	for _, entry := range env {
		if strings.Contains(entry, "Welcome") {
			t.Fatal("the greeting leaked into the environment")
		}
	}
	hanging := filepath.Join(dir, "hanging")
	if err := os.WriteFile(hanging, []byte("#!/bin/sh\nsleep 30 &\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := loginEnvironment(hanging, dir, 200*time.Millisecond); err == nil || time.Since(started) > 3*time.Second {
		t.Fatalf("a hanging startup file held the server back: %v after %v", err, time.Since(started))
	}
}
