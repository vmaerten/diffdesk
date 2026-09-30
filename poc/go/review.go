package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const maxTextBytes = 20 * 1024 * 1024

type Repository struct{ Path, GitDir string }

// Bound output even when a repository has a huge patch or a growing blob.
type limitedBuffer struct {
	buffer bytes.Buffer
	limit  int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		return 0, fmt.Errorf("Git output exceeds %d bytes", b.limit)
	}
	return b.buffer.Write(p)
}
func (r Repository) git(ctx context.Context, limit int, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", r.Path}, args...)...)
	var stdout = limitedBuffer{limit: limit}
	var stderr = limitedBuffer{limit: 64 * 1024}
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("git %s: %s (%w)", args[0], strings.TrimSpace(stderr.buffer.String()), err)
	}
	return stdout.buffer.Bytes(), nil
}
func (r Repository) text(ctx context.Context, args ...string) (string, error) {
	b, err := r.git(ctx, 256*1024*1024, args...)
	return strings.TrimSuffix(string(b), "\n"), err
}
func openRepository(ctx context.Context, path string) (Repository, error) {
	r := Repository{Path: path}
	root, err := r.text(ctx, "rev-parse", "--show-toplevel")
	if err != nil {
		return r, fmt.Errorf("Invalid repository: %w", err)
	}
	r.Path, err = filepath.EvalSymlinks(root)
	if err != nil {
		return r, err
	}
	r.GitDir, err = r.text(ctx, "rev-parse", "--absolute-git-dir")
	return r, err
}
func validRef(ref string) bool {
	return ref != "" && !strings.HasPrefix(ref, "-") && !strings.ContainsAny(ref, "\x00\r\n") && len(ref) <= 1024
}
func validPath(path string) bool {
	if path == "" || filepath.IsAbs(path) || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
			return false
		}
	}
	return true
}
func validLocation(c Comment) bool {
	return (c.Side == "additions" || c.Side == "deletions") && c.Start >= 1 && c.End >= c.Start && c.End-c.Start < maxTextBytes
}
func changed() error {
	return fmt.Errorf("Comparison changed; refresh the diff before expanding context")
}
func (r Repository) checkOperation() error {
	for _, entry := range []struct{ path, operation string }{{"MERGE_HEAD", "merge"}, {"rebase-merge", "rebase"}, {"rebase-apply", "rebase"}, {"CHERRY_PICK_HEAD", "cherry-pick"}} {
		if _, err := os.Stat(filepath.Join(r.GitDir, entry.path)); err == nil {
			return fmt.Errorf("%s in progress is outside the Go PoC scope", entry.operation)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

type section struct {
	previous, patch, oldID, newID string
	oldLines, newLines            map[int]string
}
type Review struct {
	repo              Repository
	Comparison        Comparison
	Base, Head, Range string
	Branch            *string
	Patch             string
	Files             []FileStat
	Totals            Totals
	sections          map[string]*section
	sources           map[string]*TextFile
}

// Resolve once. Patch, statistics, hashes and context all describe these versions.
func (r Repository) Compare(ctx context.Context, base string, committed bool) (*Review, error) {
	if !validRef(base) {
		return nil, fmt.Errorf("Invalid base ref")
	}
	if err := r.checkOperation(); err != nil {
		return nil, err
	}
	head, err := r.text(ctx, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return nil, fmt.Errorf("Repository has no commit: %w", err)
	}
	baseSHA, err := r.text(ctx, "rev-parse", "--verify", "--end-of-options", base+"^{commit}")
	if err != nil {
		return nil, fmt.Errorf("Invalid base %q: %w", base, err)
	}
	before, err := r.text(ctx, "merge-base", baseSHA, head)
	if err != nil {
		return nil, fmt.Errorf("Base and HEAD have no merge-base: %w", err)
	}
	review := &Review{repo: r, Base: base, Head: head, Comparison: Comparison{Before: before}, Files: []FileStat{}, sections: map[string]*section{}, sources: map[string]*TextFile{}}
	branch, err := r.text(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err == nil {
		review.Branch = &branch
	} else if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	target := "HEAD"
	if review.Branch != nil {
		target = *review.Branch
	}
	review.Range = base + ".." + target
	if committed {
		review.Comparison.After = &review.Head
	}
	args := []string{"diff", "-M", "--no-ext-diff", before}
	if committed {
		args = append(args, head)
	}
	// NUL records preserve spaces, tabs and Unicode names. Patch quoting stays Git's.
	var outputs [3][]byte
	var errors [3]error
	var wg sync.WaitGroup
	for i, options := range [][]string{{"--unified=3", "--no-color", "--no-ext-diff"}, {"--numstat", "-z", "--no-color"}, {"--name-status", "-M", "-z"}} {
		wg.Add(1)
		go func(i int, options []string) {
			defer wg.Done()
			outputs[i], errors[i] = r.git(ctx, 256*1024*1024, append(append([]string{}, args...), append(options, "--")...)...)
		}(i, options)
	}
	wg.Wait()
	for _, err := range errors {
		if err != nil {
			return nil, err
		}
	}
	if err := r.checkOperation(); err != nil {
		return nil, err
	}
	review.Patch = string(outputs[0])
	statuses, previous := parseStatuses(string(outputs[2]))
	review.Files, err = parseCounts(string(outputs[1]), statuses)
	if err != nil {
		return nil, err
	}
	review.parseSections(previous)
	for i := range review.Files {
		file := &review.Files[i]
		if s := review.sections[file.Path]; s != nil {
			hash := sha1.Sum([]byte(s.patch))
			value := hex.EncodeToString(hash[:])[:12]
			file.Hash = &value
		}
		review.Totals.Files++
		review.Totals.Additions += file.Additions
		review.Totals.Deletions += file.Deletions
	}
	return review, nil
}
func parseStatuses(raw string) (map[string]string, map[string]string) {
	fields := strings.Split(strings.TrimSuffix(raw, "\x00"), "\x00")
	statuses, previous := map[string]string{}, map[string]string{}
	for i := 0; i+1 < len(fields); {
		kind, path := fields[i], fields[i+1]
		i += 2
		status := map[byte]string{'A': "added", 'D': "deleted", 'M': "modified", 'T': "modified"}[kind[0]]
		if kind[0] == 'R' || kind[0] == 'C' {
			if i >= len(fields) {
				break
			}
			old := path
			path = fields[i]
			i++
			previous[path] = old
			status = "renamed"
			if kind[0] == 'C' {
				status = "added"
			}
		}
		if status == "" {
			status = "modified"
		}
		statuses[path] = status
	}
	return statuses, previous
}
func parseCounts(raw string, statuses map[string]string) ([]FileStat, error) {
	files := []FileStat{}
	fields := strings.Split(raw, "\x00")
	for i := 0; i < len(fields); {
		record := fields[i]
		i++
		if record == "" {
			continue
		}
		parts := strings.SplitN(record, "\t", 3)
		if len(parts) != 3 {
			return nil, fmt.Errorf("Invalid Git numstat record")
		}
		path := parts[2]
		if path == "" {
			if i+1 >= len(fields) {
				return nil, fmt.Errorf("Invalid Git rename record")
			}
			path = fields[i+1]
			i += 2
		}
		file := FileStat{Path: path, Binary: parts[0] == "-", Status: statuses[path]}
		if file.Status == "" {
			file.Status = "modified"
		}
		if !file.Binary {
			var err error
			file.Additions, err = strconv.Atoi(parts[0])
			if err != nil {
				return nil, err
			}
			file.Deletions, err = strconv.Atoi(parts[1])
			if err != nil {
				return nil, err
			}
		}
		files = append(files, file)
	}
	return files, nil
}

var hunkRE = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)
var indexRE = regexp.MustCompile(`(?m)^index ([a-f0-9]+)\.\.([a-f0-9]+)`)

// Match complete Git-quoted pairs against known NUL-delimited names. Splitting
// on " b/" alone confuses valid filenames containing that sequence.
func headerMatches(header, old, path string) bool {
	pair := strings.TrimPrefix(header, "diff --git ")
	decode := func(token string) string {
		if strings.HasPrefix(token, `"`) {
			unquoted, err := strconv.Unquote(token)
			if err != nil {
				return ""
			}
			return unquoted
		}
		return token
	}
	for i := range pair {
		if pair[i] == ' ' && decode(pair[:i]) == "a/"+old && decode(pair[i+1:]) == "b/"+path {
			return true
		}
	}
	return false
}
func (r *Review) parseSections(previous map[string]string) {
	lines := strings.Split(r.Patch, "\n")
	for start := 0; start < len(lines); {
		if !strings.HasPrefix(lines[start], "diff --git ") {
			start++
			continue
		}
		end := start + 1
		for end < len(lines) && !strings.HasPrefix(lines[end], "diff --git ") {
			end++
		}
		for _, file := range r.Files {
			old := file.Path
			if previous[file.Path] != "" {
				old = previous[file.Path]
			}
			if !headerMatches(lines[start], old, file.Path) {
				continue
			}
			s := &section{previous: old, patch: strings.Join(lines[start:end], "\n"), oldLines: map[int]string{}, newLines: map[int]string{}}
			if ids := indexRE.FindStringSubmatch(s.patch); ids != nil {
				s.oldID, s.newID = ids[1], ids[2]
			}
			oldLine, newLine, inHunk := 0, 0, false
			for _, line := range lines[start+1 : end] {
				if h := hunkRE.FindStringSubmatch(line); h != nil {
					oldLine, _ = strconv.Atoi(h[1])
					newLine, _ = strconv.Atoi(h[2])
					inHunk = true
					continue
				}
				if !inHunk || len(line) == 0 {
					continue
				}
				switch line[0] {
				case '+':
					s.newLines[newLine] = line[1:]
					newLine++
				case '-':
					s.oldLines[oldLine] = line[1:]
					oldLine++
				case ' ':
					s.oldLines[oldLine] = line[1:]
					s.newLines[newLine] = line[1:]
					oldLine++
					newLine++
				}
			}
			r.sections[file.Path] = s
			break
		}
		start = end
	}
}

func blobHash(bytes []byte) (string, string) {
	data := append([]byte(fmt.Sprintf("blob %d\x00", len(bytes))), bytes...)
	h1, h2 := sha1.Sum(data), sha256.Sum256(data)
	return hex.EncodeToString(h1[:]), hex.EncodeToString(h2[:])
}
func (r Repository) readText(ctx context.Context, revision *string, path string) (*TextFile, error) {
	if !validPath(path) {
		return nil, fmt.Errorf("Unsupported file path")
	}
	var data []byte
	if revision == nil {
		root, err := os.OpenRoot(r.Path)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		resolved, err := filepath.EvalSymlinks(filepath.Join(r.Path, path))
		if err != nil {
			return nil, err
		}
		if resolved != filepath.Join(r.Path, path) {
			return nil, fmt.Errorf("Context is available only for regular files, not symlinks or special files")
		}
		file, err := root.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		stat, err := file.Stat()
		if err != nil {
			return nil, err
		}
		if !stat.Mode().IsRegular() {
			return nil, fmt.Errorf("Context is available only for regular files, not symlinks or special files")
		}
		if stat.Size() > maxTextBytes {
			return nil, fmt.Errorf("File exceeds the 20 MB context limit")
		}
		data, err = io.ReadAll(io.LimitReader(file, stat.Size()+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > stat.Size() {
			return nil, changed()
		}
	} else {
		entry, err := r.git(ctx, 64*1024, "--literal-pathspecs", "ls-tree", "-z", "-l", *revision, "--", path)
		if err != nil {
			return nil, err
		}
		parts := strings.SplitN(string(entry), "\t", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("Context is available only for regular files")
		}
		fields := strings.Fields(parts[0])
		if len(fields) != 4 || (fields[0] != "100644" && fields[0] != "100755") || fields[1] != "blob" {
			return nil, fmt.Errorf("Context is available only for regular files")
		}
		size, err := strconv.Atoi(fields[3])
		if err != nil {
			return nil, err
		}
		if size > maxTextBytes {
			return nil, fmt.Errorf("File exceeds the 20 MB context limit")
		}
		data, err = r.git(ctx, maxTextBytes, "cat-file", "blob", fields[2])
		if err != nil {
			return nil, err
		}
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return nil, fmt.Errorf("Binary files cannot be expanded")
	}
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("Context requires UTF-8 text")
	}
	h1, h2 := blobHash(data)
	return &TextFile{Name: path, Contents: string(data), CacheKey: h2, sha1: h1}, nil
}
func (r *Review) describe(path string) (*FileStat, *section, error) {
	for i := range r.Files {
		f := &r.Files[i]
		if f.Path == path && !f.Binary && r.sections[path] != nil {
			return f, r.sections[path], nil
		}
	}
	return nil, nil, fmt.Errorf("File is not a text file in this comparison")
}
func (r *Review) source(ctx context.Context, path, side string) (*TextFile, error) {
	key := path + "\x00" + side
	if file := r.sources[key]; file != nil {
		return file, nil
	}
	stat, section, err := r.describe(path)
	if err != nil {
		return nil, err
	}
	old := side == "deletions"
	absent := old && stat.Status == "added" || !old && stat.Status == "deleted"
	file := &TextFile{Name: path, CacheKey: "empty"}
	if !absent {
		revision, name := r.Comparison.After, path
		if old {
			revision, name = &r.Comparison.Before, section.previous
		}
		file, err = r.repo.readText(ctx, revision, name)
		if err != nil {
			return nil, err
		}
	}
	oid, expected := section.newID, section.newLines
	if old {
		oid, expected = section.oldID, section.oldLines
	}
	if oid != "" && strings.Trim(oid, "0") != "" && !strings.HasPrefix(file.sha1, oid) && !strings.HasPrefix(file.CacheKey, oid) {
		return nil, changed()
	}
	lines := strings.Split(file.Contents, "\n")
	for n, text := range expected {
		if n < 1 || n > len(lines) || lines[n-1] != text {
			return nil, changed()
		}
	}
	r.sources[key] = file
	return file, nil
}
func (r *Review) Context(ctx context.Context, path, hash string) (*DiffFiles, error) {
	stat, s, err := r.describe(path)
	if err != nil {
		return nil, err
	}
	if stat.Hash == nil || *stat.Hash != hash {
		return nil, changed()
	}
	old, err := r.source(ctx, path, "deletions")
	if err != nil {
		return nil, err
	}
	now, err := r.source(ctx, path, "additions")
	if err != nil {
		return nil, err
	}
	if len(s.oldLines) == 0 && len(s.newLines) == 0 {
		if old.Contents != now.Contents {
			return nil, changed()
		}
		if stat.Status == "renamed" {
			old = nil
		}
	}
	return &DiffFiles{OldFile: old, NewFile: now}, nil
}
func (r *Review) Lines(ctx context.Context, c Comment) ([]string, error) {
	if !validLocation(c) {
		return nil, fmt.Errorf("Invalid line range")
	}
	_, section, err := r.describe(c.Path)
	if err != nil {
		return nil, err
	}
	patchLines := section.newLines
	if c.Side == "deletions" {
		patchLines = section.oldLines
	}
	result := []string{}
	for n := c.Start; n <= c.End; n++ {
		text, ok := patchLines[n]
		if !ok {
			result = nil
			break
		}
		result = append(result, text)
	}
	if result != nil {
		return result, nil
	}
	file, err := r.source(ctx, c.Path, c.Side)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(file.Contents, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if c.End > len(lines) {
		return nil, fmt.Errorf("Lines are not available in this comparison")
	}
	return lines[c.Start-1 : c.End], nil
}
func (r *Review) Comments(ctx context.Context, stored []Comment) []ServedComment {
	comments := make([]ServedComment, 0, len(stored))
	for _, c := range stored {
		served := ServedComment{Comment: c, Code: []string{}}
		present := false
		for _, f := range r.Files {
			if f.Path == c.Path {
				present = true
				break
			}
		}
		if present {
			if lines, err := r.Lines(ctx, c); err == nil {
				served.Code = lines
			}
			if len(c.Anchor) > 0 {
				served.Stale = len(served.Code) != len(c.Anchor)
				if !served.Stale {
					for i, line := range c.Anchor {
						if line != served.Code[i] {
							served.Stale = true
							break
						}
					}
				}
			}
		}
		comments = append(comments, served)
	}
	return comments
}
