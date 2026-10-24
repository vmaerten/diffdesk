package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func testServer(t *testing.T) *Server {
	r := fixture(t)
	return &Server{repo: r, id: repoID(r.Path), store: storeFor(r), assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>embedded</html>")}}}
}

func api(t *testing.T, s *Server, method, route string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw := ""
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		raw = string(encoded)
	}
	r := httptest.NewRequest(method, "http://127.0.0.1/r/"+s.id+"/api/"+route, strings.NewReader(raw))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d expected %d: %s", w.Code, status, w.Body.String())
	}
}
func TestAPICommentsViewedAndRestart(t *testing.T) {
	s := testServer(t)
	r := compare(t, s.repo, false)
	f := statFor(t, r, "context.txt")
	comment := Comment{ID: "c1", Path: f.Path, Side: "additions", Start: 90, End: 91, Range: r.Range, Body: "review"}
	w := api(t, s, "POST", "comments", comment)
	requireStatus(t, w, 200)
	var created struct {
		Comment ServedComment `json:"comment"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if strings.Join(created.Comment.Anchor, "|") != "line 90|line 91" || created.Comment.CreatedAt == "" {
		t.Fatal("missing anchor")
	}
	comment.Body = "retry"
	requireStatus(t, api(t, s, "POST", "comments", comment), 200)
	requireStatus(t, api(t, s, "PATCH", "comments", map[string]string{"id": "c1", "body": " edited "}), 200)
	requireStatus(t, api(t, s, "POST", "viewed", map[string]any{"range": r.Range, "path": f.Path, "hash": f.Hash, "viewed": true}), 200)
	// New server/store instance reads the isolated file rather than process state.
	s.store = &Store{path: s.store.path}
	w = api(t, s, "GET", "diff", nil)
	requireStatus(t, w, 200)
	var payload struct {
		Comments []ServedComment `json:"comments"`
		Viewed   ViewedMap       `json:"viewed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Comments) != 1 || payload.Comments[0].Body != "edited" || payload.Comments[0].CreatedAt != created.Comment.CreatedAt || payload.Viewed[f.Path] == nil {
		t.Fatal("restart lost state or duplicate edit")
	}
	contextQuery := "diff-files?path=" + url.QueryEscape(f.Path) + "&hash=" + *f.Hash
	requireStatus(t, api(t, s, "GET", contextQuery, nil), 200)
	requireStatus(t, api(t, s, "GET", contextQuery+"&comparison="+url.QueryEscape(`{"before":"outdated","after":null}`), nil), 409)
	writeFixture(t, s.repo.Path, f.Path, "entirely changed\n")
	requireStatus(t, api(t, s, "GET", contextQuery, nil), 409)
	w = api(t, s, "GET", "diff", nil)
	payload.Viewed = nil
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Viewed) != 0 || !payload.Comments[0].Stale {
		t.Fatal("stale state not invalidated")
	}
	// Outside comments stay editable, with their initial anchor intact.
	gitFixture(t, s.repo.Path, "checkout", "--", f.Path)
	w = api(t, s, "PATCH", "comments?base=HEAD&committed", map[string]string{"id": "c1", "body": "outside"})
	requireStatus(t, w, 200)
	var edited struct {
		Comment ServedComment `json:"comment"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &edited)
	if edited.Comment.Stale || len(edited.Comment.Code) != 0 || strings.Join(edited.Comment.Anchor, "|") != "line 90|line 91" {
		t.Fatal("outside anchor changed")
	}
	requireStatus(t, api(t, s, "DELETE", "comments?id=c1", nil), 200)
	state, _, err := s.store.Snapshot()
	if err != nil || len(state.Comments) != 0 || len(state.Viewed[r.Range]) != 1 {
		t.Fatal("delete affected viewed state")
	}
	requireStatus(t, api(t, s, "POST", "viewed", map[string]any{"range": r.Range, "clear": true}), 200)
}
func TestAPIValidationAndSecurity(t *testing.T) {
	s := testServer(t)
	for _, q := range []string{"includeUntracked=false", "base=", "target=", "commit="} {
		requireStatus(t, api(t, s, "GET", "diff?"+q, nil), 400)
		requireStatus(t, api(t, s, "DELETE", "comments?id=test&"+q, nil), 400)
	}
	requireStatus(t, api(t, s, "GET", "diff?base=missing", nil), 422)
	requireStatus(t, api(t, s, "GET", "diff-files", nil), 400)
	for _, body := range []any{map[string]any{"range": "r", "path": "../escape", "viewed": true}, map[string]any{"range": "r", "path": "ok", "viewed": "true"}} {
		requireStatus(t, api(t, s, "POST", "viewed", body), 400)
	}
	requireStatus(t, api(t, s, "POST", "comments", Comment{ID: "c", Path: "context.txt", Side: "additions", Start: 0, End: 1, Range: "r"}), 400)
	requireStatus(t, api(t, s, "PATCH", "comments", map[string]string{"id": "missing", "body": "ok"}), 404)
	for _, test := range []struct {
		host, origin string
		status       int
	}{{"evil.example", "", 403}, {"127.0.0.1", "https://evil.example", 403}, {"localhost", "null", 403}, {"ghl.localhost", "", 403}, {"localhost:1234", "http://localhost:1234", 200}} {
		r := httptest.NewRequest("POST", "http://127.0.0.1/r/"+s.id+"/api/viewed", strings.NewReader(`{"range":"r","clear":true}`))
		r.Host = test.host
		if test.origin != "" {
			r.Header.Set("Origin", test.origin)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		requireStatus(t, w, test.status)
	}
	r := httptest.NewRequest("GET", "http://localhost/r/"+s.id, nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	requireStatus(t, w, 200)
	if w.Body.String() != "<html>embedded</html>" {
		t.Fatal("missing app shell")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r = httptest.NewRequest("GET", "http://localhost/r/"+s.id+"/api/diff", nil).WithContext(ctx)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if !strings.Contains(w.Body.String(), "canceled") {
		t.Fatal("request cancellation lost")
	}
}

func TestCorruptStateIsReported(t *testing.T) {
	s := testServer(t)
	writeFixture(t, s.repo.GitDir, "ghl/state.json", "{")
	w := api(t, s, "GET", "diff?base=main", nil)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), "corrupt") {
		t.Fatal("corruption notice not served")
	}
}
