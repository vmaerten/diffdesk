package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	snippetLines    = 10
	maxDefinitions  = 5
	maxReferences   = 500
	maxLineBytes    = 1000
	lspQueryTimeout = 30 * time.Second
)

// errStaleSymbol means the file on disk no longer holds the token the diff
// showed there: the review needs a refresh before a server can answer.
var errStaleSymbol = errors.New("This file changed on disk since the review loaded: refresh to look it up")

var languageIDs = map[string]string{
	".go": "go", ".rs": "rust", ".py": "python", ".pyi": "python", ".tf": "terraform", ".tfvars": "terraform-vars",
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
	".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
}

// languageID is what LSP calls the file's language.
func languageID(l language, path string) string {
	if l.Templates {
		return l.ID
	}
	return languageIDs[strings.ToLower(filepath.Ext(path))]
}

// languageFor finds the language of path; templates are the charts' templates
// folders, which hold Helm's files.
func (m *languageServers) languageFor(path string, templates []string) (language, bool) {
	extension := strings.ToLower(filepath.Ext(path))
	inTemplates := slices.ContainsFunc(templates, func(dir string) bool { return strings.HasPrefix(path, dir+"/") })
	for _, l := range m.languages {
		if slices.Contains(l.Extensions, extension) && l.Templates == inTemplates {
			return l, true
		}
	}
	return language{}, false
}

// chartTemplates lists the templates folder of each Helm chart Git tracks.
func (s *Server) chartTemplates(ctx context.Context) []string {
	listing, err := s.repo.git(ctx, 1<<20, "ls-files", "-z", "--", ":(glob)**/Chart.yaml")
	if err != nil {
		return nil
	}
	templates := []string{}
	for _, chart := range strings.Split(string(listing), "\x00") {
		if dir, ok := strings.CutSuffix(chart, "Chart.yaml"); ok {
			templates = append(templates, dir+"templates")
		}
	}
	return templates
}

// symbolQuery names a token the diff showed: line counts from 1, as the diff
// does, and character in UTF-16 code units, as LSP and JavaScript do.
type symbolQuery struct {
	Path      string
	Line      int
	Character int
	Token     string
}

var identifierRE = regexp.MustCompile(`^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]*$`)

func (q symbolQuery) valid() bool {
	return validPath(q.Path) && q.Line >= 1 && q.Character >= 0 && len(q.Token) <= 256 && identifierRE.MatchString(q.Token)
}

func splitLines(data []byte) []string {
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

// utf16Index is the byte offset of a UTF-16 offset in line, if it falls on a
// character boundary.
func utf16Index(line string, units int) (int, bool) {
	count := 0
	for index, r := range line {
		if count == units {
			return index, true
		}
		if count > units {
			return 0, false
		}
		count += utf16.RuneLen(r)
	}
	return len(line), count == units
}

func utf16Len(text string) int {
	count := 0
	for _, r := range text {
		count += utf16.RuneLen(r)
	}
	return count
}

// tokenAt says whether the token still sits where the diff showed it.
func tokenAt(lines []string, q symbolQuery) bool {
	if q.Line > len(lines) {
		return false
	}
	line := lines[q.Line-1]
	start, ok := utf16Index(line, q.Character)
	if !ok {
		return false
	}
	end, ok := utf16Index(line, q.Character+utf16Len(q.Token))
	return ok && line[start:end] == q.Token
}

type openDocument struct {
	version int
	hash    [sha256.Size]byte
}

// sync gives the server the file as it is on disk: opened the first time,
// replaced whole when its bytes changed.
func (c *languageClient) sync(path, uri, languageID string, data []byte) error {
	c.docMu.Lock()
	defer c.docMu.Unlock()
	if c.docs == nil {
		c.docs = map[string]openDocument{}
	}
	hash := sha256.Sum256(data)
	document, open := c.docs[path]
	if open && document.hash == hash {
		return nil
	}
	document.version++
	document.hash = hash
	var err error
	if open {
		err = c.conn.notify("textDocument/didChange", map[string]any{
			"textDocument":   map[string]any{"uri": uri, "version": document.version},
			"contentChanges": []map[string]string{{"text": string(data)}},
		})
	} else {
		err = c.conn.notify("textDocument/didOpen", map[string]any{
			"textDocument": map[string]any{"uri": uri, "languageId": languageID, "version": document.version, "text": string(data)},
		})
	}
	if err == nil {
		c.docs[path] = document
	}
	return err
}

// prepare finds the server for the query's file, checks the token against the
// disk and syncs the document.
func (s *Server) prepare(ctx context.Context, q symbolQuery) (*languageClient, language, map[string]any, error) {
	l, ok := s.lsp.languageFor(q.Path, s.chartTemplates(ctx))
	if !ok {
		return nil, l, nil, fmt.Errorf("No language server serves %s", q.Path)
	}
	file, err := s.repo.worktreeFile(q.Path)
	if err != nil {
		return nil, l, nil, sourceError(err, false)
	}
	if !tokenAt(splitLines(file.data), q) {
		return nil, l, nil, errStaleSymbol
	}
	client, err := s.lsp.client(ctx, s.repo.Path, l.ID)
	if err != nil {
		return nil, l, nil, err
	}
	uri := fileURI(filepath.Join(s.repo.Path, filepath.FromSlash(q.Path)))
	if err := client.sync(q.Path, uri, languageID(l, q.Path), file.data); err != nil {
		return nil, l, nil, err
	}
	position := map[string]any{"textDocument": map[string]string{"uri": uri}, "position": map[string]int{"line": q.Line - 1, "character": q.Character}}
	return client, l, position, nil
}

type lspRange struct {
	Start struct {
		Line      int `json:"line"`
		Character int `json:"character"`
	} `json:"start"`
	End struct {
		Line      int `json:"line"`
		Character int `json:"character"`
	} `json:"end"`
}

type lspLocation struct {
	URI   string   `json:"uri"`
	Range lspRange `json:"range"`
}

// locations reads Location, Location[] and LocationLink[], the three shapes a
// definition can take.
func locations(raw json.RawMessage) []lspLocation {
	var many []struct {
		lspLocation
		TargetURI            string    `json:"targetUri"`
		TargetSelectionRange *lspRange `json:"targetSelectionRange"`
	}
	if json.Unmarshal(raw, &many) != nil {
		var one lspLocation
		if json.Unmarshal(raw, &one) != nil || one.URI == "" {
			return nil
		}
		return []lspLocation{one}
	}
	result := make([]lspLocation, 0, len(many))
	for _, item := range many {
		if item.TargetURI != "" && item.TargetSelectionRange != nil {
			result = append(result, lspLocation{URI: item.TargetURI, Range: *item.TargetSelectionRange})
		} else if item.URI != "" {
			result = append(result, item.lspLocation)
		}
	}
	return result
}

// repositoryPath is the repository-relative path of a file URI, or "" with the
// absolute path when the file lies outside the repository. Servers differ in
// whether they resolve symlinks, so both sides are resolved before comparing.
func (s *Server) repositoryPath(uri string) (relative, absolute string) {
	parsed, err := url.Parse(uri)
	if err != nil || parsed.Scheme != "file" {
		return "", uri
	}
	absolute = parsed.Path
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		resolved = absolute
	}
	relative, err = filepath.Rel(s.repo.Path, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", absolute
	}
	relative = filepath.ToSlash(relative)
	if !validPath(relative) {
		return "", absolute
	}
	return relative, absolute
}

// truncate keeps a line readable: minified code can hold megabytes on one line.
func truncate(line string) string {
	if len(line) <= maxLineBytes {
		return line
	}
	cut := maxLineBytes
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	return line[:cut]
}

// fileLines reads repository files once per request.
type fileLines map[string][]string

func (f fileLines) get(s *Server, path string) []string {
	if lines, ok := f[path]; ok {
		return lines
	}
	var lines []string
	if file, err := s.repo.worktreeFile(path); err == nil {
		lines = splitLines(file.data)
	}
	f[path] = lines
	return lines
}

type hoverBlock struct {
	// code or text.
	Kind     string `json:"kind"`
	Language string `json:"language,omitempty"`
	Text     string `json:"text"`
}

var (
	fenceRE = regexp.MustCompile("(?s)```([\\w+-]*)\\n(.*?)\\n?```")
	linkRE  = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	ruleRE  = regexp.MustCompile(`(?m)^\s*(?:-{3,}|\*{3,}|_{3,})\s*$`)
)

// hoverBlocks turns a hover's Markdown into code and text blocks: the window
// shows signatures in the code font, and prose without its links, which lead
// to documentation sites the review cannot vouch for. raw is the Hover result.
func hoverBlocks(raw json.RawMessage) []hoverBlock {
	var markdown []string
	var content struct {
		Contents json.RawMessage `json:"contents"`
	}
	if json.Unmarshal(raw, &content) != nil || len(content.Contents) == 0 {
		return []hoverBlock{}
	}
	var list []json.RawMessage
	add := func(item json.RawMessage) {
		var text string
		var markup struct {
			Kind     string `json:"kind"`
			Value    string `json:"value"`
			Language string `json:"language"`
		}
		if json.Unmarshal(item, &text) == nil {
			markdown = append(markdown, text)
		} else if json.Unmarshal(item, &markup) == nil {
			if markup.Language != "" {
				markdown = append(markdown, "```"+markup.Language+"\n"+markup.Value+"\n```")
			} else if markup.Kind == "plaintext" {
				markdown = append(markdown, "```\n"+markup.Value+"\n```")
			} else {
				markdown = append(markdown, markup.Value)
			}
		}
	}
	if json.Unmarshal(content.Contents, &list) == nil {
		for _, item := range list {
			add(item)
		}
	} else {
		add(content.Contents)
	}
	blocks := []hoverBlock{}
	text := func(value string) {
		value = strings.TrimSpace(linkRE.ReplaceAllString(ruleRE.ReplaceAllString(value, ""), "$1"))
		if value != "" {
			blocks = append(blocks, hoverBlock{Kind: "text", Text: value})
		}
	}
	for _, part := range markdown {
		last := 0
		for _, match := range fenceRE.FindAllStringSubmatchIndex(part, -1) {
			text(part[last:match[0]])
			if code := strings.TrimRight(part[match[4]:match[5]], "\n"); strings.TrimSpace(code) != "" {
				blocks = append(blocks, hoverBlock{Kind: "code", Language: part[match[2]:match[3]], Text: code})
			}
			last = match[1]
		}
		text(part[last:])
	}
	return blocks
}

type definitionSnippet struct {
	Start int      `json:"start"`
	Lines []string `json:"lines"`
}

type symbolDefinition struct {
	// Repository-relative when InRepo, absolute otherwise.
	Path      string             `json:"path"`
	Line      int                `json:"line"`
	Character int                `json:"character"`
	InRepo    bool               `json:"inRepo"`
	Snippet   *definitionSnippet `json:"snippet,omitempty"`
}

type symbolAnswer struct {
	Language    string             `json:"language"`
	Server      string             `json:"server"`
	Hover       []hoverBlock       `json:"hover"`
	Definitions []symbolDefinition `json:"definitions"`
}

// symbol asks for the hover and the definitions of a token at once. One of
// them failing still leaves the other worth showing.
func (s *Server) symbol(ctx context.Context, q symbolQuery) (symbolAnswer, error) {
	client, l, position, err := s.prepare(ctx, q)
	if err != nil {
		return symbolAnswer{}, err
	}
	var hover, definition json.RawMessage
	hoverErr, definitionErr := make(chan error, 1), make(chan error, 1)
	go func() { hoverErr <- client.conn.call(ctx, "textDocument/hover", position, &hover) }()
	go func() { definitionErr <- client.conn.call(ctx, "textDocument/definition", position, &definition) }()
	if first, second := <-hoverErr, <-definitionErr; first != nil && second != nil {
		return symbolAnswer{}, first
	}
	answer := symbolAnswer{Language: l.ID, Server: client.serverName(), Hover: hoverBlocks(hover), Definitions: []symbolDefinition{}}
	files := fileLines{}
	for _, location := range locations(definition) {
		if len(answer.Definitions) == maxDefinitions {
			break
		}
		found := symbolDefinition{Line: location.Range.Start.Line + 1, Character: location.Range.Start.Character}
		relative, absolute := s.repositoryPath(location.URI)
		found.Path, found.InRepo = absolute, relative != ""
		if found.InRepo {
			found.Path = relative
			if lines := files.get(s, relative); found.Line <= len(lines) {
				end := min(found.Line-1+snippetLines, len(lines))
				snippet := &definitionSnippet{Start: found.Line, Lines: []string{}}
				for _, line := range lines[found.Line-1 : end] {
					snippet.Lines = append(snippet.Lines, truncate(line))
				}
				found.Snippet = snippet
			}
		}
		answer.Definitions = append(answer.Definitions, found)
	}
	return answer, nil
}

type symbolReference struct {
	Path         string `json:"path"`
	Line         int    `json:"line"`
	Character    int    `json:"character"`
	EndCharacter int    `json:"endCharacter"`
	Text         string `json:"text"`
}

type referencesAnswer struct {
	References []symbolReference `json:"references"`
	// References outside the repository, such as in a module cache.
	External  int  `json:"external"`
	Truncated bool `json:"truncated"`
}

func (s *Server) references(ctx context.Context, q symbolQuery) (referencesAnswer, error) {
	client, _, position, err := s.prepare(ctx, q)
	if err != nil {
		return referencesAnswer{}, err
	}
	params := map[string]any{"textDocument": position["textDocument"], "position": position["position"], "context": map[string]bool{"includeDeclaration": false}}
	var found []lspLocation
	if err := client.conn.call(ctx, "textDocument/references", params, &found); err != nil {
		return referencesAnswer{}, err
	}
	answer := referencesAnswer{References: []symbolReference{}}
	files := fileLines{}
	for _, location := range found {
		relative, _ := s.repositoryPath(location.URI)
		if relative == "" {
			answer.External++
			continue
		}
		if len(answer.References) == maxReferences {
			answer.Truncated = true
			continue
		}
		reference := symbolReference{Path: relative, Line: location.Range.Start.Line + 1, Character: location.Range.Start.Character, EndCharacter: location.Range.End.Character}
		if location.Range.End.Line != location.Range.Start.Line {
			reference.EndCharacter = reference.Character
		}
		if lines := files.get(s, relative); reference.Line <= len(lines) {
			reference.Text = truncate(lines[reference.Line-1])
		}
		answer.References = append(answer.References, reference)
	}
	slices.SortStableFunc(answer.References, func(a, b symbolReference) int {
		if a.Path != b.Path {
			return strings.Compare(a.Path, b.Path)
		}
		return a.Line - b.Line
	})
	return answer, nil
}

func (c *languageClient) serverName() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.server.Name
}

// changed tells the running servers of root that the review's files changed:
// a server that watches nothing itself would otherwise answer from stale files.
func (m *languageServers) changed(root string, files []FileStat) {
	m.mu.Lock()
	var clients []*languageClient
	for key, client := range m.clients {
		if key.root == root && closedChannel(client.ready) {
			clients = append(clients, client)
		}
	}
	m.mu.Unlock()
	if len(clients) == 0 || len(files) == 0 {
		return
	}
	changes := make([]map[string]any, 0, len(files))
	for _, file := range files {
		kind := 2
		switch file.Status {
		case "added", "untracked":
			kind = 1
		case "deleted":
			kind = 3
		}
		changes = append(changes, map[string]any{"uri": fileURI(filepath.Join(root, filepath.FromSlash(file.Path))), "type": kind})
	}
	for _, client := range clients {
		if client.failure() == nil {
			_ = client.conn.notify("workspace/didChangeWatchedFiles", map[string]any{"changes": changes})
		}
	}
}

func closedChannel(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}
