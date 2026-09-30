package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Server struct {
	repo     Repository
	id, base string
	store    *Store
	assets   fs.FS
	poc      bool
}

var errCommentMissing = errors.New("Comment no longer exists")

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func fail(w http.ResponseWriter, status int, err error) {
	reply(w, status, map[string]string{"error": err.Error()})
}
func allowedName(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "ghl.localhost", "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}
func decode(w http.ResponseWriter, r *http.Request, body any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(body); err != nil {
		return fmt.Errorf("Invalid JSON body: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("Expected one JSON object")
	}
	return nil
}
func (s *Server) selection(r *http.Request) (string, bool, error) {
	q := r.URL.Query()
	for _, key := range []string{"target", "commit", "untracked", "includeUntracked"} {
		if q.Has(key) {
			return "", false, fmt.Errorf("%s is not supported by this Go runtime", key)
		}
	}
	base := s.base
	if q.Has("base") {
		base = q.Get("base")
	}
	if !validRef(base) {
		return "", false, fmt.Errorf("Invalid base ref")
	}
	return base, q.Has("committed"), nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedName("http://" + r.Host) {
		fail(w, 403, fmt.Errorf("unexpected Host header"))
		return
	}
	if origin, ok := r.Header["Origin"]; r.Method != "GET" && ok && (len(origin) != 1 || !allowedName(origin[0])) {
		fail(w, 403, fmt.Errorf("unexpected Origin header"))
		return
	}
	if r.URL.Path == "/api/health" && r.Method == "GET" {
		info := buildInfo()
		health := map[string]any{
			"ghlGo": true, "version": info.Version, "commit": info.Commit,
			"buildDate": info.BuildDate, "runtime": info.Runtime, "protocolVersion": info.ProtocolVersion,
			"revision": info.Version + "/" + info.Commit,
			"pid":      os.Getpid(), "repos": []any{map[string]string{"id": s.id, "path": s.repo.Path}},
		}
		if s.poc {
			health["ghlGoPoc"] = true
		}
		reply(w, 200, health)
		return
	}
	prefix := "/r/" + s.id
	if r.URL.Path == prefix || r.URL.Path == prefix+"/" {
		if r.Method == "GET" {
			s.static(w, r, "index.html")
			return
		}
	}
	if !strings.HasPrefix(r.URL.Path, prefix+"/api/") {
		if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/assets/") {
			s.static(w, r, strings.TrimPrefix(r.URL.Path, "/"))
			return
		}
		fail(w, 404, fmt.Errorf("not found"))
		return
	}
	base, committed, err := s.selection(r)
	if err != nil {
		fail(w, 400, err)
		return
	}
	route := strings.TrimPrefix(r.URL.Path, prefix+"/api/")
	// Only routes that read a comparison pay for Git. Every reader uses this result.
	var review *Review
	if (r.Method == "GET" && (route == "diff" || route == "diff-files")) || (route == "comments" && (r.Method == "POST" || r.Method == "PATCH")) {
		review, err = s.repo.Compare(r.Context(), base, committed)
		if err != nil {
			fail(w, 422, err)
			return
		}
	}
	switch {
	case route == "diff" && r.Method == "GET":
		state, notice, err := s.store.Snapshot()
		if err != nil {
			fail(w, 500, err)
			return
		}
		viewed := ViewedMap{}
		for _, file := range review.Files {
			hash, ok := state.Viewed[review.Range][file.Path]
			if ok && file.Hash != nil && hash != nil && *file.Hash == *hash {
				viewed[file.Path] = hash
			}
		}
		target := "HEAD"
		if review.Branch != nil {
			target = *review.Branch
		}
		reply(w, 200, map[string]any{
			"comparison": review.Comparison, "repo": map[string]string{"id": s.id, "path": s.repo.Path},
			"base": map[string]any{"ref": review.Base, "source": "override", "branch": review.Branch, "trunk": nil, "stack": nil},
			"head": map[string]any{"branch": review.Branch, "sha": review.Head}, "target": map[string]any{"ref": target, "workingTree": !committed},
			"commit": nil, "range": review.Range, "state": map[string]any{"operation": nil, "conflicted": []string{}},
			"untracked": []string{}, "untrackedIncluded": false, "files": review.Files, "totals": review.Totals,
			"viewed": viewed, "comments": review.Comments(r.Context(), state.Comments), "notice": notice, "patch": review.Patch,
		})
	case route == "diff-files" && r.Method == "GET":
		q := r.URL.Query()
		if q.Get("path") == "" || q.Get("hash") == "" {
			fail(w, 400, fmt.Errorf("Missing path or expected file hash"))
			return
		}
		if !validPath(q.Get("path")) {
			fail(w, 422, fmt.Errorf("Unsupported file path"))
			return
		}
		expected, _ := json.Marshal(review.Comparison)
		if q.Has("comparison") && q.Get("comparison") != string(expected) {
			fail(w, 409, changed())
			return
		}
		files, err := review.Context(r.Context(), q.Get("path"), q.Get("hash"))
		if err != nil {
			status := 422
			if strings.Contains(err.Error(), "refresh") {
				status = 409
			}
			fail(w, status, err)
			return
		}
		reply(w, 200, files)
	case route == "viewed" && r.Method == "POST":
		var body struct {
			Range  string  `json:"range"`
			Path   string  `json:"path"`
			Hash   *string `json:"hash"`
			Viewed *bool   `json:"viewed"`
			Clear  bool    `json:"clear"`
		}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return
		}
		if body.Range == "" || (!body.Clear && (!validPath(body.Path) || body.Viewed == nil)) {
			fail(w, 400, fmt.Errorf("A range, path and viewed boolean are required"))
			return
		}
		state, err := s.store.Mutate(func(state *StoredState) error {
			if state.Viewed[body.Range] == nil || body.Clear {
				state.Viewed[body.Range] = ViewedMap{}
			}
			if !body.Clear {
				if *body.Viewed {
					state.Viewed[body.Range][body.Path] = body.Hash
				} else {
					delete(state.Viewed[body.Range], body.Path)
				}
			}
			return nil
		})
		if err != nil {
			fail(w, 500, err)
			return
		}
		reply(w, 200, map[string]any{"viewed": state.Viewed[body.Range]})
	case route == "comments" && r.Method == "POST":
		var c Comment
		if err := decode(w, r, &c); err != nil {
			fail(w, 400, err)
			return
		}
		if c.ID == "" || !validPath(c.Path) || c.Range == "" || !validLocation(c) {
			fail(w, 400, fmt.Errorf("A comment ID, path, range and valid line location are required"))
			return
		}
		anchor, err := review.Lines(r.Context(), c)
		if err != nil {
			fail(w, 400, err)
			return
		}
		c.Anchor, c.CreatedAt = anchor, time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		state, err := s.store.Mutate(func(state *StoredState) error { upsert(state, c); return nil })
		if err != nil {
			fail(w, 500, err)
			return
		}
		for _, saved := range state.Comments {
			if saved.ID == c.ID {
				c = saved
				break
			}
		}
		reply(w, 200, map[string]any{"comment": review.Comments(r.Context(), []Comment{c})[0], "comments": state.Comments})
	case route == "comments" && r.Method == "PATCH":
		var body struct {
			ID   string `json:"id"`
			Body string `json:"body"`
		}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return
		}
		body.Body = strings.TrimSpace(body.Body)
		if body.ID == "" || body.Body == "" {
			fail(w, 400, fmt.Errorf("A comment ID and non-empty body are required"))
			return
		}
		var saved *Comment
		_, err := s.store.Mutate(func(state *StoredState) error {
			for i := range state.Comments {
				if state.Comments[i].ID == body.ID {
					state.Comments[i].Body = body.Body
					c := state.Comments[i]
					saved = &c
					return nil
				}
			}
			return errCommentMissing
		})
		if err != nil {
			status := 500
			if errors.Is(err, errCommentMissing) {
				status = 404
			}
			fail(w, status, err)
			return
		}
		reply(w, 200, map[string]any{"comment": review.Comments(r.Context(), []Comment{*saved})[0]})
	case route == "comments" && r.Method == "DELETE":
		id := r.URL.Query().Get("id")
		if id == "" {
			fail(w, 400, fmt.Errorf("missing id"))
			return
		}
		state, err := s.store.Mutate(func(state *StoredState) error {
			kept := make([]Comment, 0, len(state.Comments))
			for _, c := range state.Comments {
				if c.ID != id {
					kept = append(kept, c)
				}
			}
			state.Comments = kept
			return nil
		})
		if err != nil {
			fail(w, 500, err)
			return
		}
		reply(w, 200, map[string]any{"comments": state.Comments})
	default:
		fail(w, 404, fmt.Errorf("not found"))
	}
}
func (s *Server) static(w http.ResponseWriter, r *http.Request, name string) {
	if !fs.ValidPath(name) {
		fail(w, 404, fmt.Errorf("not found"))
		return
	}
	file, err := s.assets.Open(name)
	if err != nil {
		fail(w, 404, fmt.Errorf("not found"))
		return
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		fail(w, 404, fmt.Errorf("not found"))
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, name, stat.ModTime(), file.(io.ReadSeeker))
}
