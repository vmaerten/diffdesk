package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// languageServer is one way to serve a language. A checkout path wins over
// PATH: it is the version the project chose.
type languageServer struct {
	Name string
	// What the language's setting calls this server.
	Choice string
	// Inside the repository, such as node_modules/.bin/tsrs; empty looks command up on PATH.
	checkout string
	command  string
	args     []string
	// Whether the checkout can run it, beyond the file existing.
	usable func(root string) bool
	// Asks for references with the declaration: pyright, without it, leaves
	// out the use the pointer is on and keeps the declarations anyway.
	declarations bool
}

type language struct {
	ID, Label  string
	Extensions []string
	// Owns only files under a chart's templates folder, which share their
	// extensions with every other YAML file.
	Templates bool
	// In Auto's order.
	Servers []languageServer
	// How to install a server when none is found, in the order offered.
	Installs []installMethod
}

func defaultLanguages() []language {
	return []language{
		{ID: "go", Label: "Go", Extensions: []string{".go"},
			Installs: []installMethod{mise("go:golang.org/x/tools/gopls"), brew("gopls"), {"go", []string{"go", "install", "golang.org/x/tools/gopls@latest"}}},
			Servers:  []languageServer{{Name: "gopls", Choice: "gopls", command: "gopls"}}},
		{ID: "typescript", Label: "TypeScript", Extensions: []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"},
			Installs: []installMethod{mise("npm:tsrs"), {"npm", []string{"npm", "install", "--global", "tsrs"}}},
			// tsrs before the checkout's own tsc: it answers the same protocol faster
			// and in less memory (79 against 115 ms to a first hover, 99 against 159 MB).
			Servers: []languageServer{
				{Name: "tsrs", Choice: "tsrs", checkout: "node_modules/.bin/tsrs", args: []string{"--lsp", "-stdio"}},
				{Name: "tsrs", Choice: "tsrs", command: "tsrs", args: []string{"--lsp", "-stdio"}},
				// typescript-language-server needs the tsserver.js that TypeScript 7 no longer ships;
				// TypeScript 7 serves LSP itself.
				{Name: "tsc", Choice: "tsc", checkout: "node_modules/.bin/tsc", args: []string{"--lsp", "--stdio"}, usable: typeScriptSeven},
				{Name: "typescript-language-server", Choice: "typescript-language-server", command: "typescript-language-server", args: []string{"--stdio"}},
			}},
		{ID: "python", Label: "Python", Extensions: []string{".py", ".pyi"},
			Installs: []installMethod{mise("pipx:basedpyright"), brew("basedpyright"), {"uv", []string{"uv", "tool", "install", "basedpyright"}}},
			Servers: []languageServer{
				{Name: "basedpyright", Choice: "basedpyright", checkout: ".venv/bin/basedpyright-langserver", args: []string{"--stdio"}, declarations: true},
				{Name: "pyright", Choice: "pyright", checkout: ".venv/bin/pyright-langserver", args: []string{"--stdio"}, declarations: true},
				{Name: "basedpyright", Choice: "basedpyright", command: "basedpyright-langserver", args: []string{"--stdio"}, declarations: true},
				{Name: "pyright", Choice: "pyright", command: "pyright-langserver", args: []string{"--stdio"}, declarations: true},
				{Name: "ty", Choice: "ty", command: "ty", args: []string{"server"}},
			}},
		{ID: "terraform", Label: "Terraform", Extensions: []string{".tf", ".tfvars"},
			Installs: []installMethod{mise("terraform-ls"), brew("terraform-ls")},
			Servers:  []languageServer{{Name: "terraform-ls", Choice: "terraform-ls", command: "terraform-ls", args: []string{"serve"}}}},
		{ID: "helm", Label: "Helm", Extensions: []string{".yaml", ".yml", ".tpl", ".txt"}, Templates: true,
			Installs: []installMethod{mise("helm-ls"), brew("helm-ls")},
			Servers:  []languageServer{{Name: "helm_ls", Choice: "helm_ls", command: "helm_ls", args: []string{"serve"}}}},
		{ID: "rust", Label: "Rust", Extensions: []string{".rs"},
			Installs: []installMethod{mise("rust-analyzer"), brew("rust-analyzer"), {"rustup", []string{"rustup", "component", "add", "rust-analyzer"}}},
			Servers:  []languageServer{{Name: "rust-analyzer", Choice: "rust-analyzer", command: "rust-analyzer"}}},
	}
}

func typeScriptSeven(root string) bool {
	raw, err := os.ReadFile(filepath.Join(root, "node_modules", "typescript", "package.json"))
	var manifest struct {
		Version string `json:"version"`
	}
	if err != nil || json.Unmarshal(raw, &manifest) != nil {
		return false
	}
	major, _, _ := strings.Cut(manifest.Version, ".")
	version, err := strconv.Atoi(major)
	return err == nil && version >= 7
}

// choices are the values a language's setting accepts: auto, each distinct
// server, then off.
func (l language) choices() []string {
	result := []string{"auto"}
	for _, server := range l.Servers {
		if !slices.Contains(result, server.Choice) {
			result = append(result, server.Choice)
		}
	}
	return append(result, "off")
}

// lspConfig is what Settings says about code intelligence. Nothing starts
// until the window sends one with Enabled.
type lspConfig struct {
	Enabled bool              `json:"enabled"`
	Servers map[string]string `json:"servers"`
}

func (c lspConfig) choice(language string) string {
	if choice := c.Servers[language]; choice != "" {
		return choice
	}
	return "auto"
}

var (
	errLSPDisabled = errors.New("Code intelligence is off")
	errLSPClosed   = errors.New("The review server is stopping")
)

type resolvedServer struct {
	Name         string   `json:"name"`
	Path         string   `json:"path"`
	Origin       string   `json:"origin"`
	Args         []string `json:"-"`
	Declarations bool     `json:"-"`
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0
}

func lookIn(pathList, name string) string {
	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" || !filepath.IsAbs(dir) {
			continue
		}
		if candidate := filepath.Join(dir, name); isExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

func environmentValue(env []string, name string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if value, ok := strings.CutPrefix(env[i], name+"="); ok {
			return value
		}
	}
	return ""
}

// find returns the first server the choice allows that this checkout and
// environment can run, or nil.
func (l language) find(root string, env []string, choice string) *resolvedServer {
	if choice == "off" {
		return nil
	}
	for _, server := range l.Servers {
		if choice != "auto" && choice != server.Choice {
			continue
		}
		found := resolvedServer{Name: server.Name, Args: server.args, Declarations: server.declarations}
		if server.checkout != "" {
			found.Path, found.Origin = filepath.Join(root, filepath.FromSlash(server.checkout)), "checkout"
			if !isExecutable(found.Path) || (server.usable != nil && !server.usable(root)) {
				continue
			}
		} else if found.Path, found.Origin = lookIn(environmentValue(env, "PATH"), server.command), "PATH"; found.Path == "" {
			continue
		}
		return &found
	}
	return nil
}

type clientKey struct{ root, language string }

type progressReport struct {
	Title      string `json:"title"`
	Message    string `json:"message,omitempty"`
	Percentage *int   `json:"percentage,omitempty"`
}

// tailBuffer keeps the end of a server's stderr, which says why it failed.
type tailBuffer struct {
	mu   sync.Mutex
	data []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if extra := len(b.data) - 4096; extra > 0 {
		b.data = b.data[extra:]
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(string(b.data))
}

// languageClient is one running server for one repository and language.
type languageClient struct {
	// The setting it was started for: a different one replaces it.
	choice string
	ready  chan struct{}
	exited chan struct{}
	stderr tailBuffer

	mu          sync.Mutex
	server      resolvedServer
	stopped     bool
	initialized bool
	conn        *rpcConn
	cmd         *exec.Cmd
	stdin       io.Closer
	err         error
	failedAt    time.Time
	version     string
	progress    map[string]progressReport
	last        string
	idle        *time.Timer

	// The documents sent to the server, by repository path.
	docMu sync.Mutex
	docs  map[string]openDocument
}

func (c *languageClient) failure() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// recentFailure is the failure of a server that stopped less than retry ago.
func (c *languageClient) recentFailure(retry time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil && time.Since(c.failedAt) < retry {
		return c.err
	}
	return nil
}

// languageServers starts, shares and stops the language servers of every
// repository the runtime serves.
type languageServers struct {
	mu          sync.Mutex
	config      lspConfig
	clients     map[clientKey]*languageClient
	envs        map[string]*environmentEntry
	closed      bool
	workspaceMu sync.Mutex
	workspaces  map[string]revisionWorkspace
	origins     map[string]string
	installing  map[string]*installJob
	// Stops the installs still running when the review server stops.
	installContext context.Context
	cancelInstalls context.CancelFunc

	languages []language
	// The environment servers run in; the login shell's unless a test replaces it.
	environment func(root string) []string
	idle        time.Duration
	retry       time.Duration
}

type environmentEntry struct {
	mu  sync.Mutex
	env []string
	at  time.Time
}

func newLanguageServers() *languageServers {
	ctx, cancel := context.WithCancel(context.Background())
	return &languageServers{
		clients: map[clientKey]*languageClient{}, envs: map[string]*environmentEntry{},
		workspaces: map[string]revisionWorkspace{}, origins: map[string]string{},
		installing: map[string]*installJob{}, installContext: ctx, cancelInstalls: cancel,
		languages: defaultLanguages(), environment: serverEnvironment,
		idle: 10 * time.Minute, retry: 30 * time.Second,
	}
}

// env is resolved once a minute at most: the login shell takes half a second,
// and a server installed meanwhile shows up at the next look.
func (m *languageServers) env(root string) []string {
	root = m.origin(root)
	m.mu.Lock()
	entry := m.envs[root]
	if entry == nil {
		entry = &environmentEntry{}
		m.envs[root] = entry
	}
	m.mu.Unlock()
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.env == nil || time.Since(entry.at) > time.Minute {
		entry.env, entry.at = m.environment(root), time.Now()
	}
	return entry.env
}

func (m *languageServers) language(id string) (language, bool) {
	for _, l := range m.languages {
		if l.ID == id {
			return l, true
		}
	}
	return language{}, false
}

func (m *languageServers) validate(config lspConfig) error {
	for id, choice := range config.Servers {
		l, ok := m.language(id)
		if !ok {
			return fmt.Errorf("Unknown language %q", id)
		}
		if !slices.Contains(l.choices(), choice) {
			return fmt.Errorf("Unknown server %q for %s", choice, l.Label)
		}
	}
	return nil
}

// configure applies new settings and stops the servers they no longer allow.
func (m *languageServers) configure(config lspConfig) error {
	if err := m.validate(config); err != nil {
		return err
	}
	m.mu.Lock()
	m.config = config
	var stopping []*languageClient
	for key, client := range m.clients {
		if !config.Enabled || config.choice(key.language) != client.choice {
			stopping = append(stopping, client)
			delete(m.clients, key)
		}
	}
	m.mu.Unlock()
	stopClients(stopping)
	return nil
}

// close stops every server; nothing starts afterwards.
func (m *languageServers) close() {
	m.mu.Lock()
	m.closed = true
	stopping := make([]*languageClient, 0, len(m.clients))
	for key, client := range m.clients {
		stopping = append(stopping, client)
		delete(m.clients, key)
	}
	m.mu.Unlock()
	stopClients(stopping)
	m.stopInstalls()
	m.closeWorkspaces()
}

func stopClients(clients []*languageClient) {
	var wg sync.WaitGroup
	for _, client := range clients {
		wg.Add(1)
		go func() { defer wg.Done(); client.stop() }()
	}
	wg.Wait()
}

// client returns the running server for a language in root, starting it on
// first use. A start that failed is not retried for a while: the pointer
// pauses on many symbols, and each would otherwise spawn it again.
func (m *languageServers) client(ctx context.Context, root, languageID string) (*languageClient, error) {
	key := clientKey{root, languageID}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errLSPClosed
	}
	if !m.config.Enabled {
		m.mu.Unlock()
		return nil, errLSPDisabled
	}
	l, ok := m.language(languageID)
	if !ok {
		m.mu.Unlock()
		return nil, fmt.Errorf("Unknown language %q", languageID)
	}
	choice := m.config.choice(languageID)
	if choice == "off" {
		m.mu.Unlock()
		return nil, fmt.Errorf("%s code intelligence is off", l.Label)
	}
	client := m.clients[key]
	if client != nil {
		select {
		case <-client.exited:
			if err := client.recentFailure(m.retry); err != nil {
				m.mu.Unlock()
				return nil, err
			}
			client = nil
		default:
		}
	}
	if client == nil {
		client = &languageClient{choice: choice, ready: make(chan struct{}), exited: make(chan struct{}), progress: map[string]progressReport{}}
		m.clients[key] = client
		go m.start(client, root, l, choice)
	}
	m.mu.Unlock()
	select {
	case <-client.ready:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if err := client.failure(); err != nil {
		return nil, err
	}
	m.touch(key, client)
	return client, nil
}

// touch postpones the idle stop.
func (m *languageServers) touch(key clientKey, client *languageClient) {
	client.mu.Lock()
	defer client.mu.Unlock()
	if client.idle != nil {
		client.idle.Stop()
	}
	client.idle = time.AfterFunc(m.idle, func() {
		m.mu.Lock()
		if m.clients[key] != client {
			m.mu.Unlock()
			return
		}
		delete(m.clients, key)
		m.mu.Unlock()
		client.stop()
	})
}

func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

// start runs the server and initializes it; ready closes either way.
func (m *languageServers) start(client *languageClient, root string, l language, choice string) {
	// Before the process runs, nothing needs stopping.
	abandon := func(err error) {
		client.mu.Lock()
		client.err, client.failedAt = err, time.Now()
		client.mu.Unlock()
		close(client.exited)
		close(client.ready)
	}
	fail := func(err error) {
		client.mu.Lock()
		client.err, client.failedAt = err, time.Now()
		client.mu.Unlock()
		client.stop()
		close(client.ready)
	}
	env := m.env(root)
	server := m.findServer(root, l, env, choice)
	if server == nil {
		_, command := l.installs(env)
		abandon(fmt.Errorf("No %s language server found: %s", l.Label, command))
		return
	}
	client.mu.Lock()
	client.server = *server
	client.mu.Unlock()
	cmd := exec.Command(server.Path, server.Args...)
	cmd.Dir, cmd.Env, cmd.Stderr = root, env, &client.stderr
	// Its own group, so stopping it also stops what it spawned, such as go list.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		abandon(err)
		return
	}
	// Not StdoutPipe: Wait would close it while the reader may still be reading.
	output, input, err := os.Pipe()
	if err != nil {
		abandon(err)
		return
	}
	cmd.Stdout = input
	err = cmd.Start()
	input.Close()
	if err != nil {
		output.Close()
		abandon(fmt.Errorf("%s could not start: %w", server.Name, err))
		return
	}
	conn := newRPCConn(stdin, output, rpcHandlers{
		request: func(method string, params json.RawMessage) (any, error) {
			return answerServer(method, params, root)
		},
		notify: func(method string, params json.RawMessage) {
			if method == "$/progress" {
				client.report(params)
			}
		},
	})
	client.mu.Lock()
	client.cmd, client.conn, client.stdin = cmd, conn, stdin
	stopped := client.stopped
	client.mu.Unlock()
	go func() {
		err := cmd.Wait()
		output.Close()
		client.mu.Lock()
		if client.err == nil && err != nil {
			client.err, client.failedAt = exitError(server.Name, err, client.stderr.String()), time.Now()
		}
		client.mu.Unlock()
		close(client.exited)
	}()
	// Settings turned it off, or the runtime stopped, while it was starting.
	if stopped {
		fail(errLSPClosed)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var initialized struct {
		ServerInfo *struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
	}
	if err := conn.call(ctx, "initialize", initializeParams(root), &initialized); err != nil {
		select {
		case <-client.exited:
			// The exit says more than the closed stream.
			err = client.failure()
		case <-time.After(100 * time.Millisecond):
		}
		if err == nil {
			err = fmt.Errorf("%s did not initialize", server.Name)
		}
		fail(fmt.Errorf("%s did not start: %w", server.Name, err))
		return
	}
	if info := initialized.ServerInfo; info != nil {
		client.mu.Lock()
		client.version = strings.TrimSpace(info.Version)
		client.mu.Unlock()
	}
	if err := conn.notify("initialized", struct{}{}); err != nil {
		fail(err)
		return
	}
	client.mu.Lock()
	client.initialized = true
	client.mu.Unlock()
	close(client.ready)
}

func exitError(name string, err error, stderr string) error {
	if stderr == "" {
		return fmt.Errorf("%s stopped: %w", name, err)
	}
	return fmt.Errorf("%s stopped: %w: %s", name, err, stderr)
}

func initializeParams(root string) map[string]any {
	return map[string]any{
		// A server watches this process and exits with it.
		"processId":        os.Getpid(),
		"clientInfo":       map[string]string{"name": "diffdesk", "version": buildInfo().Version},
		"rootUri":          fileURI(root),
		"workspaceFolders": []map[string]string{{"uri": fileURI(root), "name": filepath.Base(root)}},
		"capabilities": map[string]any{
			"general": map[string]any{"positionEncodings": []string{"utf-16"}},
			"textDocument": map[string]any{
				"synchronization": map[string]any{},
				"hover":           map[string]any{"contentFormat": []string{"markdown", "plaintext"}},
				"definition":      map[string]any{"linkSupport": false},
				"references":      map[string]any{},
			},
			"window": map[string]any{"workDoneProgress": true},
			"workspace": map[string]any{
				"workspaceFolders":       true,
				"configuration":          true,
				"didChangeWatchedFiles":  map[string]any{"dynamicRegistration": false},
				"workspaceEdit":          map[string]any{"documentChanges": false},
				"didChangeConfiguration": map[string]any{"dynamicRegistration": false},
			},
		},
	}
}

// answerServer replies to the requests a server makes of its client. Diffdesk has
// no settings to give, and registers nothing.
func answerServer(method string, params json.RawMessage, root string) (any, error) {
	switch method {
	case "workspace/configuration":
		var request struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(params, &request)
		return make([]any, len(request.Items)), nil
	case "workspace/workspaceFolders":
		return []map[string]string{{"uri": fileURI(root), "name": filepath.Base(root)}}, nil
	case "window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability", "window/showMessageRequest":
		return nil, nil
	case "workspace/applyEdit":
		return map[string]any{"applied": false}, nil
	}
	return nil, &rpcError{Code: -32601, Message: "method not found: " + method}
}

// report follows the server's work-done progress: indexing, loading packages.
func (c *languageClient) report(params json.RawMessage) {
	var progress struct {
		Token json.RawMessage `json:"token"`
		Value struct {
			Kind       string `json:"kind"`
			Title      string `json:"title"`
			Message    string `json:"message"`
			Percentage *int   `json:"percentage"`
		} `json:"value"`
	}
	if json.Unmarshal(params, &progress) != nil {
		return
	}
	token := string(progress.Token)
	c.mu.Lock()
	defer c.mu.Unlock()
	switch progress.Value.Kind {
	case "begin":
		c.progress[token] = progressReport{Title: progress.Value.Title, Message: progress.Value.Message, Percentage: progress.Value.Percentage}
		c.last = token
	case "report":
		if report, ok := c.progress[token]; ok {
			report.Message, report.Percentage = progress.Value.Message, progress.Value.Percentage
			c.progress[token] = report
		}
	case "end":
		delete(c.progress, token)
	}
}

// stop asks the server to shut down, then stops its process group. A server
// still starting stops as soon as its process runs.
func (c *languageClient) stop() {
	c.mu.Lock()
	c.stopped = true
	conn, cmd, stdin, polite := c.conn, c.cmd, c.stdin, c.initialized
	if c.idle != nil {
		c.idle.Stop()
	}
	c.mu.Unlock()
	if conn == nil || cmd == nil {
		return
	}
	select {
	case <-c.exited:
	default:
		if polite {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if conn.call(ctx, "shutdown", nil, nil) == nil {
				_ = conn.notify("exit", nil)
			}
			cancel()
		}
		stdin.Close()
		select {
		case <-c.exited:
		case <-time.After(2 * time.Second):
		}
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	<-c.exited
}

type languageStatus struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	Extensions []string `json:"extensions"`
	// For Helm, the charts' templates folders, as the language owns no other file.
	Directories []string        `json:"directories,omitempty"`
	Choice      string          `json:"choice"`
	Choices     []string        `json:"choices"`
	Server      *resolvedServer `json:"server"`
	Version     string          `json:"version,omitempty"`
	// off, missing, idle, starting, indexing, ready or failed.
	State    string          `json:"state"`
	Progress *progressReport `json:"progress,omitempty"`
	// The command to show for a missing server, and the ones the page may run.
	Install  string          `json:"install,omitempty"`
	Installs []installOption `json:"installs,omitempty"`
	// The manager installing the server now, or the install that failed.
	Installing   string          `json:"installing,omitempty"`
	InstallError *installFailure `json:"installError,omitempty"`
	Error        string          `json:"error,omitempty"`
}

type lspStatus struct {
	Enabled   bool                   `json:"enabled"`
	Languages []languageStatus       `json:"languages"`
	Workspace *intelligenceWorkspace `json:"workspace,omitempty"`
}

// status says, for each language, which server root would use and what it is doing.
func (m *languageServers) status(root string, templates []string) lspStatus {
	env := m.env(root)
	m.mu.Lock()
	config := m.config
	clients := map[string]*languageClient{}
	for key, client := range m.clients {
		if key.root == root {
			clients[key.language] = client
		}
	}
	m.mu.Unlock()
	result := lspStatus{Enabled: config.Enabled, Languages: []languageStatus{}}
	for _, l := range m.languages {
		entry := languageStatus{ID: l.ID, Label: l.Label, Extensions: l.Extensions, Choice: config.choice(l.ID), Choices: l.choices(), State: "idle"}
		if l.Templates {
			entry.Directories = templates
		}
		entry.Server = m.findServer(root, l, env, entry.Choice)
		switch client := clients[l.ID]; {
		case entry.Choice == "off":
			entry.State = "off"
		case client != nil:
			client.describe(&entry)
		}
		if entry.Server == nil {
			if entry.State != "off" {
				entry.State = "missing"
			}
			entry.Installs, entry.Install = l.installs(env)
			m.describeInstall(&entry)
		}
		result.Languages = append(result.Languages, entry)
	}
	return result
}

func (c *languageClient) describe(entry *languageStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server.Path != "" {
		server := c.server
		entry.Server = &server
	}
	entry.Version = c.version
	select {
	case <-c.exited:
		if c.err != nil {
			entry.State, entry.Error = "failed", c.err.Error()
		}
		return
	default:
	}
	select {
	case <-c.ready:
		entry.State = "ready"
		if report, ok := c.progress[c.last]; ok {
			entry.State, entry.Progress = "indexing", &report
		} else {
			for _, report := range c.progress {
				entry.State, entry.Progress = "indexing", &report
				break
			}
		}
	default:
		entry.State = "starting"
	}
}
