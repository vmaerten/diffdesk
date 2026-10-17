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
	"strconv"
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
func (s *Server) selection(r *http.Request) (Selection, error) {
	q := r.URL.Query()
	excluded := []string{"includeUntracked"}
	if s.poc {
		excluded = append(excluded, "target", "commit", "untracked", "w")
	}
	for _, key := range excluded {
		if q.Has(key) {
			return Selection{}, fmt.Errorf("%s is not supported by this Go runtime", key)
		}
	}
	for _, key := range []string{"base", "target", "commit"} {
		if q.Has(key) && !validRef(q.Get(key)) {
			return Selection{}, fmt.Errorf("Invalid %s ref", key)
		}
	}
	base := q.Get("base")
	if s.poc && !q.Has("base") {
		base = s.base
	}
	return Selection{Base: base, Target: q.Get("target"), Commit: q.Get("commit"), Committed: q.Has("committed"), IncludeUntracked: q.Has("untracked"), IgnoreWhitespace: q.Get("w") == "1"}, nil
}
func allowedRequest(w http.ResponseWriter, r *http.Request) bool {
	if !allowedName("http://" + r.Host) {
		fail(w, 403, fmt.Errorf("unexpected Host header"))
		return false
	}
	if origin, ok := r.Header["Origin"]; r.Method != "GET" && ok && (len(origin) != 1 || !allowedName(origin[0])) {
		fail(w, 403, fmt.Errorf("unexpected Origin header"))
		return false
	}
	return true
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedRequest(w, r) {
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
	selection, err := s.selection(r)
	if err != nil {
		fail(w, 400, err)
		return
	}
	route := strings.TrimPrefix(r.URL.Path, prefix+"/api/")
	// Only routes that read a comparison pay for Git. Every reader uses this result.
	var review *Review
	if (r.Method == "GET" && (route == "diff" || route == "diff-files")) || (route == "comments" && (r.Method == "POST" || r.Method == "PATCH")) {
		if s.poc {
			review, err = s.repo.Compare(r.Context(), selection.Base, selection.Committed)
		} else {
			review, err = s.repo.Resolve(r.Context(), selection)
		}
		if err != nil {
			fail(w, 422, err)
			return
		}
	}
	switch {
	case !s.poc && route == "image" && r.Method == "GET":
		q := r.URL.Query()
		source, err := s.repo.imageSource(r.Context(), q.Get("revision"), q.Get("path"))
		var data []byte
		if err == nil {
			data, err = source.read(r.Context())
		}
		if err != nil {
			fail(w, 404, fmt.Errorf("Image preview unavailable"))
			return
		}
		w.Header().Set("Content-Type", imageType(q.Get("path")))
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
		w.WriteHeader(200)
		_, _ = w.Write(data)
	case !s.poc && route == "refs" && r.Method == "GET":
		refs, err := s.repo.refs(r.Context())
		if err != nil {
			fail(w, 422, err)
			return
		}
		trunk, err := s.repo.trunk(r.Context())
		if err != nil {
			fail(w, 422, err)
			return
		}
		branch, err := s.repo.currentBranch(r.Context())
		if err != nil {
			fail(w, 422, err)
			return
		}
		reply(w, 200, map[string]any{"refs": refs, "trunk": trunk, "branch": branch})
	case !s.poc && route == "commits" && r.Method == "GET":
		base, err := s.repo.resolveBase(r.Context(), selection.Base, selection.Target)
		if err != nil {
			fail(w, 422, err)
			return
		}
		target := "HEAD"
		if base.Branch != nil {
			target = *base.Branch
		}
		commits, err := s.repo.commits(r.Context(), base.Ref, target)
		if err != nil {
			fail(w, 422, err)
			return
		}
		reply(w, 200, map[string]any{"commits": commits})
	case !s.poc && route == "base" && r.Method == "POST":
		var body struct {
			Base   string  `json:"base"`
			Target *string `json:"target"`
		}
		if err := decode(w, r, &body); err != nil {
			fail(w, 400, err)
			return
		}
		if !validRef(body.Base) || (body.Target != nil && !validRef(*body.Target)) {
			fail(w, 400, fmt.Errorf("Valid base and target refs are required"))
			return
		}
		branch := body.Target
		if branch == nil {
			branch, err = s.repo.currentBranch(r.Context())
		} else {
			var sha string
			sha, err = s.repo.resolveRef(r.Context(), *branch)
			if err == nil && sha == "" {
				err = fmt.Errorf("Invalid target %q", *branch)
			}
		}
		if err == nil {
			err = s.repo.rememberBase(r.Context(), branch, body.Base)
		}
		if err != nil {
			fail(w, 422, err)
			return
		}
		reply(w, 200, map[string]any{"ok": true, "branch": branch, "base": body.Base})
	case route == "diff" && r.Method == "GET":
		if !s.poc {
			if err := review.attachImages(r.Context(), s.id); err != nil {
				fail(w, 422, err)
				return
			}
		}
		state, notice, err := s.store.Snapshot(r.Context())
		if err != nil {
			fail(w, 500, err)
			return
		}
		viewed := ViewedMap{}
		for _, file := range review.Files {
			hash, ok := state.Viewed[viewedRange(review.Range, selection.IgnoreWhitespace)][file.Path]
			if ok && file.Hash != nil && hash != nil && *file.Hash == *hash {
				viewed[file.Path] = hash
			}
		}
		messages := []string{}
		if notice != nil {
			messages = append(messages, *notice)
		}
		if review.Notice != nil {
			messages = append(messages, *review.Notice)
		}
		if len(messages) > 0 {
			joined := strings.Join(messages, " — ")
			notice = &joined
		}
		reply(w, 200, map[string]any{
			"comparison": review.Comparison, "repo": map[string]string{"id": s.id, "path": s.repo.Path},
			"base": review.Resolution,
			"head": map[string]any{"branch": review.Branch, "sha": review.Head}, "target": map[string]any{"ref": review.Target, "workingTree": review.Comparison.After == nil},
			"commit": review.Commit, "range": review.Range, "state": map[string]any{"operation": nil, "conflicted": []string{}},
			"untracked": review.Untracked, "untrackedIncluded": review.UntrackedIncluded, "files": review.Files, "totals": review.Totals,
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
		body.Range = viewedRange(body.Range, selection.IgnoreWhitespace)
		state, err := s.store.Mutate(r.Context(), func(state *StoredState) error {
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
		state, err := s.store.Mutate(r.Context(), func(state *StoredState) error { upsert(state, c); return nil })
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
		_, err := s.store.Mutate(r.Context(), func(state *StoredState) error {
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
		state, err := s.store.Mutate(r.Context(), func(state *StoredState) error {
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
