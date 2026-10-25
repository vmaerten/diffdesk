package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestHoverBlocks(t *testing.T) {
	gopls := json.RawMessage(`{"contents":{"kind":"markdown","value":"` + "```go\\nfunc Mutate(ctx context.Context) error\\n```\\n\\n---\\n\\nMutate takes the lock.\\n\\n[`Store.Mutate` on pkg.go.dev](https://pkg.go.dev/x)" + `"}}`)
	legacy := json.RawMessage(`{"contents":[{"language":"typescript","value":"const answer: 42"},"The *answer*.",{"kind":"plaintext","value":"a < b"}]}`)
	cases := []struct {
		raw  json.RawMessage
		want []hoverBlock
	}{
		{gopls, []hoverBlock{{Kind: "code", Language: "go", Text: "func Mutate(ctx context.Context) error"}, {Kind: "text", Text: "Mutate takes the lock.\n\n`Store.Mutate` on pkg.go.dev"}}},
		{legacy, []hoverBlock{{Kind: "code", Language: "typescript", Text: "const answer: 42"}, {Kind: "text", Text: "The *answer*."}, {Kind: "code", Text: "a < b"}}},
		{json.RawMessage(`null`), []hoverBlock{}},
	}
	for _, c := range cases {
		if got := hoverBlocks(c.raw); !reflect.DeepEqual(got, c.want) {
			t.Errorf("hoverBlocks(%s) = %+v, want %+v", c.raw, got, c.want)
		}
	}
}

func TestTokenPositionsCountUTF16(t *testing.T) {
	lines := splitLines([]byte("package é\r\n\tcafé, 🙂 := Mutate(x)\n"))
	for _, q := range []symbolQuery{
		{Line: 2, Character: 1, Token: "café"},
		// The emoji is two UTF-16 units, as JavaScript counts it.
		{Line: 2, Character: 13, Token: "Mutate"},
	} {
		if !tokenAt(lines, q) {
			t.Errorf("token %q not found at %d:%d", q.Token, q.Line, q.Character)
		}
	}
	for _, q := range []symbolQuery{
		{Line: 2, Character: 12, Token: "Mutate"},
		// Inside the emoji's surrogate pair.
		{Line: 2, Character: 8, Token: "x"},
		{Line: 9, Character: 0, Token: "x"},
	} {
		if tokenAt(lines, q) {
			t.Errorf("token %q found at %d:%d", q.Token, q.Line, q.Character)
		}
	}
}

func TestDefinitionShapes(t *testing.T) {
	want := []lspLocation{{URI: "file:///a.go"}}
	want[0].Range.Start.Line, want[0].Range.End.Line = 3, 3
	for _, raw := range []string{
		`{"uri":"file:///a.go","range":{"start":{"line":3,"character":0},"end":{"line":3,"character":0}}}`,
		`[{"uri":"file:///a.go","range":{"start":{"line":3,"character":0},"end":{"line":3,"character":0}}}]`,
		`[{"targetUri":"file:///a.go","targetRange":{"start":{"line":0,"character":0},"end":{"line":9,"character":0}},"targetSelectionRange":{"start":{"line":3,"character":0},"end":{"line":3,"character":0}}}]`,
	} {
		if got := locations(json.RawMessage(raw)); !reflect.DeepEqual(got, want) {
			t.Errorf("locations(%s) = %+v", raw, got)
		}
	}
	if got := locations(json.RawMessage(`null`)); len(got) != 0 {
		t.Errorf("no definition: %+v", got)
	}
}

func TestSymbolAndReferenceRoutes(t *testing.T) {
	m, _, _ := fakeServers(t, "ok")
	runtime := NewRuntime(nil)
	runtime.lsp = m
	repo := fixture(t)
	writeFixture(t, repo.Path, "main.go", "package main\n\nfunc main() {\n\tvar s Store\n\ts.Mutate()\n}\n")
	writeFixture(t, repo.Path, "store.go", "package main\n\ntype Store struct{}\n\nfunc (s *Store) Mutate() {}\n")
	writeFixture(t, repo.Path, "caller.go", "package main\n\nfunc g(s *Store) { s.Mutate() }\n")
	entry, err := runtime.Open(context.Background(), repo.Path)
	if err != nil {
		t.Fatal(err)
	}
	get := func(route string, query url.Values) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		runtime.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1/r/"+entry.ID+"/api/"+route+"?"+query.Encode(), nil))
		return w
	}
	mutate := url.Values{"path": {"main.go"}, "line": {"5"}, "character": {"3"}, "token": {"Mutate"}}
	requireStatus(t, get("lsp/symbol", mutate), 422)
	_ = m.configure(lspConfig{Enabled: true})
	requireStatus(t, get("lsp/symbol", url.Values{"path": {"main.go"}, "line": {"5"}, "character": {"3"}, "token": {"s.Mutate"}}), 400)
	requireStatus(t, get("lsp/symbol", url.Values{"path": {"../main.go"}, "line": {"5"}, "character": {"3"}, "token": {"Mutate"}}), 400)
	requireStatus(t, get("lsp/symbol", url.Values{"path": {"main.go"}, "line": {"5"}, "character": {"2"}, "token": {"Mutate"}}), 409)

	reply := get("lsp/symbol", mutate)
	requireStatus(t, reply, 200)
	var symbol symbolAnswer
	if err := json.Unmarshal(reply.Body.Bytes(), &symbol); err != nil {
		t.Fatal(err)
	}
	if symbol.Language != "go" || symbol.Server != "fakels" || len(symbol.Hover) != 2 || symbol.Hover[0].Text != "func (s *Store) Mutate()" {
		t.Fatalf("hover: %s", reply.Body.String())
	}
	if len(symbol.Definitions) != 2 {
		t.Fatalf("definitions: %s", reply.Body.String())
	}
	inside, outside := symbol.Definitions[0], symbol.Definitions[1]
	if !inside.InRepo || inside.Path != "store.go" || inside.Line != 3 || inside.Snippet == nil || inside.Snippet.Lines[0] != "type Store struct{}" || len(inside.Snippet.Lines) != 3 {
		t.Fatalf("a definition in the repository: %+v", inside)
	}
	if outside.InRepo || outside.Path != "/usr/local/go/src/context/context.go" || outside.Snippet != nil {
		t.Fatalf("a definition outside the repository: %+v", outside)
	}

	reply = get("lsp/references", mutate)
	requireStatus(t, reply, 200)
	var references referencesAnswer
	if err := json.Unmarshal(reply.Body.Bytes(), &references); err != nil {
		t.Fatal(err)
	}
	want := []symbolReference{
		{Path: "caller.go", Line: 3, Character: 8, EndCharacter: 14, Text: "func g(s *Store) { s.Mutate() }"},
		{Path: "main.go", Line: 5, Character: 2, EndCharacter: 8, Text: "\ts.Mutate()"},
	}
	if !reflect.DeepEqual(references.References, want) || references.External != 1 || references.Truncated {
		t.Fatalf("references: %s", reply.Body.String())
	}

	writeFixture(t, repo.Path, "main.go", "package main\n\nfunc main() {\n\tvar s Store\n\ts.Mutate() // again\n}\n")
	requireStatus(t, get("lsp/symbol", mutate), 200)
	diff := httptest.NewRecorder()
	runtime.ServeHTTP(diff, httptest.NewRequest("GET", "http://127.0.0.1/r/"+entry.ID+"/api/diff?base=main", nil))
	requireStatus(t, diff, 200)
	client, err := m.client(context.Background(), repo.Path, "go")
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Documents []string `json:"documents"`
		Watched   int      `json:"watched"`
	}
	if err := client.conn.call(context.Background(), "fake/state", nil, &state); err != nil {
		t.Fatal(err)
	}
	documents := []string{"textDocument/didOpen main.go v1", "textDocument/didChange main.go v2"}
	if !reflect.DeepEqual(state.Documents, documents) || state.Watched != 1 {
		t.Fatalf("the server was not kept in step with the disk: %+v", state)
	}
}

// The real servers, when this machine has them: their answers must read as Diffdesk expects.
func TestRealLanguageServersAnswer(t *testing.T) {
	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		language, server, command string
		files                     map[string]string
		path, token               string
		line                      int
		// Empty leaves the definition and references unchecked.
		definition string
		// terraform-ls answers, inside a local's expression, with the local's references.
		skipReferences bool
	}{
		{"go", "gopls", "gopls", map[string]string{
			"go.mod":  "module example.com/fixture\n\ngo 1.22\n",
			"main.go": "package main\n\nfunc main() {\n\thelper()\n}\n",
			"util.go": "package main\n\n// helper does nothing.\nfunc helper() {}\n",
		}, "main.go", "helper", 4, "util.go", false},
		{"typescript", "tsc", "", map[string]string{
			"index.ts":  "import { answer } from './answer'\n\nconsole.log(answer)\n",
			"answer.ts": "/** The answer. */\nexport const answer = 42\n",
		}, "index.ts", "answer", 3, "answer.ts", false},
		{"terraform", "terraform-ls", "terraform-ls", map[string]string{
			"variables.tf": "variable \"region\" {\n  type    = string\n  default = \"eu-west-3\"\n}\n",
			"main.tf":      "locals {\n  zone = \"${var.region}a\"\n}\n",
		}, "main.tf", "region", 2, "variables.tf", true},
		{"python", "basedpyright", "basedpyright-langserver", map[string]string{
			"main.py": "from util import helper\n\nhelper()\n",
			"util.py": "def helper() -> None:\n    \"\"\"Does nothing.\"\"\"\n",
		}, "main.py", "helper", 3, "util.py", false},
		{"helm", "helm_ls", "helm_ls", map[string]string{
			"chart/Chart.yaml":                "apiVersion: v2\nname: fixture\nversion: 0.1.0\n",
			"chart/values.yaml":               "replicaCount: 2\n",
			"chart/templates/deployment.yaml": "replicas: {{ .Values.replicaCount }}\n",
		}, "chart/templates/deployment.yaml", "replicaCount", 1, "", true},
	}
	for _, c := range cases {
		t.Run(c.server, func(t *testing.T) {
			t.Parallel()
			root, _ := filepath.EvalSymlinks(t.TempDir())
			switch c.server {
			default:
				if _, err := exec.LookPath(c.command); err != nil {
					t.Skip(c.command + " is not installed")
				}
			case "tsc":
				if !typeScriptSeven(repoRoot) {
					t.Skip("TypeScript 7 is not installed in this checkout")
				}
				if err := os.Symlink(filepath.Join(repoRoot, "node_modules"), filepath.Join(root, "node_modules")); err != nil {
					t.Fatal(err)
				}
			}
			for name, contents := range c.files {
				writeFixture(t, root, name, contents)
			}
			// Helm owns a chart's templates, which Diffdesk finds among the files Git tracks.
			gitFixture(t, root, "init", "-q")
			gitFixture(t, root, "add", ".")
			m := newLanguageServers()
			m.environment = func(string) []string { return os.Environ() }
			t.Cleanup(m.close)
			_ = m.configure(lspConfig{Enabled: true, Servers: map[string]string{c.language: c.server}})
			s := &Server{repo: Repository{Path: root}, lsp: m}
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			line := strings.Split(c.files[c.path], "\n")[c.line-1]
			q := symbolQuery{Path: c.path, Line: c.line, Character: utf16Len(line[:strings.Index(line, c.token)]), Token: c.token}
			symbol, err := s.symbol(ctx, q)
			if err != nil {
				t.Fatal(err)
			}
			if len(symbol.Hover) == 0 || !strings.Contains(symbol.Hover[0].Text, c.token) {
				t.Fatalf("hover: %+v", symbol.Hover)
			}
			if c.definition == "" {
				return
			}
			if len(symbol.Definitions) == 0 || symbol.Definitions[0].Path != c.definition || !symbol.Definitions[0].InRepo || symbol.Definitions[0].Snippet == nil {
				t.Fatalf("definitions: %+v", symbol.Definitions)
			}
			if c.skipReferences {
				return
			}
			references, err := s.references(ctx, q)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, reference := range references.References {
				found = found || (reference.Path == c.path && reference.Line == c.line && strings.Contains(reference.Text, c.token))
			}
			if !found {
				t.Fatalf("references miss %s:%s: %+v", c.path, strconv.Itoa(c.line), references)
			}
		})
	}
}

func TestHelmTemplatesBelongToTheirChart(t *testing.T) {
	s := testServer(t)
	writeFixture(t, s.repo.Path, "deploy/chart/Chart.yaml", "apiVersion: v2\nname: fixture\nversion: 0.1.0\n")
	writeFixture(t, s.repo.Path, "deploy/chart/templates/deployment.yaml", "replicas: {{ .Values.replicaCount }}\n")
	writeFixture(t, s.repo.Path, "ops/templates/issue.yaml", "title: no chart here\n")
	gitFixture(t, s.repo.Path, "add", "deploy", "ops")
	s.lsp = newLanguageServers()
	templates := s.chartTemplates(context.Background())
	if !reflect.DeepEqual(templates, []string{"deploy/chart/templates"}) {
		t.Fatalf("charts: %v", templates)
	}
	for path, want := range map[string]string{
		"deploy/chart/templates/deployment.yaml": "helm",
		"deploy/chart/values.yaml":               "",
		"ops/templates/issue.yaml":               "",
		"infra/main.tf":                          "terraform",
		"app/main.py":                            "python",
	} {
		l, ok := s.lsp.languageFor(path, templates)
		if got := map[bool]string{true: l.ID}[ok]; got != want {
			t.Errorf("%s belongs to %q, not %q", path, got, want)
		}
	}
	for _, l := range s.lsp.status(s.repo.Path, templates).Languages {
		if l.ID == "helm" && !reflect.DeepEqual(l.Directories, templates) {
			t.Fatalf("Helm's status names its folders: %+v", l)
		}
	}
}
