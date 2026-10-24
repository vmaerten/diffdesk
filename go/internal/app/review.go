package app

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const maxTextBytes = 20 * 1024 * 1024

type Repository struct{ Path, GitDir string }

// Bound output even when a repository has a huge patch or a growing blob.
type limitedBuffer struct {
	buffer bytes.Buffer
	limit  int
	err    error
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.buffer.Len() {
		b.err = fmt.Errorf("Git output exceeds %d bytes", b.limit)
		return 0, b.err
	}
	return b.buffer.Write(p)
}
func (r Repository) git(ctx context.Context, limit int, args ...string) ([]byte, error) {
	return r.gitOutput(ctx, limit, false, args...)
}
func (r Repository) gitOutput(ctx context.Context, limit int, differenceOK bool, args ...string) ([]byte, error) {
	// The patch parsers expect blank context lines to keep their leading space.
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", r.Path, "-c", "diff.suppressBlankEmpty=false"}, args...)...)
	var stdout = limitedBuffer{limit: limit}
	var stderr = limitedBuffer{limit: 64 * 1024}
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if stdout.err != nil {
			return nil, stdout.err
		}
		if stderr.err != nil {
			return nil, stderr.err
		}
		var exited *exec.ExitError
		// No-index also returns 1 for some real errors (for example a missing
		// source). Only accept an actual diff with no diagnostic or truncation.
		if differenceOK && errors.As(err, &exited) && exited.ExitCode() == 1 && stdout.buffer.Len() > 0 && stderr.buffer.Len() == 0 {
			return stdout.buffer.Bytes(), nil
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
	CommentBranch     string
	Branch            *string
	Resolution        BaseResolution
	Target            string
	Commit            *CommitDetail
	Notice            *string
	Patch             string
	Files             []FileStat
	Totals            Totals
	Untracked         []string
	UntrackedIncluded bool
	ignoreWhitespace  bool
	sections          map[string]*section
	sources           map[string]*TextFile
}

// Resolve once. Patch, statistics, hashes and context all describe these versions.
func (r Repository) Resolve(ctx context.Context, selection Selection) (*Review, error) {
	return r.compare(ctx, selection, true)
}
func (r Repository) compare(ctx context.Context, selection Selection, automatic bool) (*Review, error) {
	if (!automatic || selection.Base != "") && !validRef(selection.Base) {
		return nil, fmt.Errorf("Invalid base ref")
	}
	for _, ref := range []string{selection.Target, selection.Commit} {
		if ref != "" && !validRef(ref) {
			return nil, fmt.Errorf("Invalid revision %q", ref)
		}
	}
	if err := r.checkOperation(); err != nil {
		return nil, err
	}
	head, err := r.text(ctx, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil {
		return nil, fmt.Errorf("Repository has no commit: %w", err)
	}
	branch, err := r.currentBranch(ctx)
	if err != nil {
		return nil, err
	}
	target := "HEAD"
	if branch != nil {
		target = *branch
	}
	tip := head
	if selection.Target != "" {
		target = selection.Target
		tip, err = r.resolveRef(ctx, target)
		if err != nil {
			return nil, err
		}
		if tip == "" {
			return nil, fmt.Errorf("Invalid target %q: does not resolve to a revision", target)
		}
	}
	resolution := BaseResolution{Ref: selection.Base, Source: "override", Branch: branch}
	if automatic {
		reviewing := branch
		if selection.Target != "" {
			reviewing = &selection.Target
		}
		resolution, err = r.baseFor(ctx, selection.Base, reviewing)
		if err != nil {
			return nil, err
		}
	}
	baseSHA, err := r.resolveRef(ctx, resolution.Ref)
	if err != nil {
		return nil, err
	}
	if baseSHA == "" {
		return nil, fmt.Errorf("Invalid base %q: does not resolve to a revision", resolution.Ref)
	}
	review := &Review{repo: r, Base: resolution.Ref, Resolution: resolution, Head: head, Branch: branch, Target: target, Files: []FileStat{}, Untracked: []string{}, ignoreWhitespace: selection.IgnoreWhitespace, sections: map[string]*section{}, sources: map[string]*TextFile{}}
	// Commit selection and base changes keep the reviewed branch's comments.
	// Detached checkouts use their revision rather than sharing a global HEAD scope.
	review.CommentBranch = strings.TrimPrefix(target, "refs/heads/")
	if target == "HEAD" {
		review.CommentBranch = head
		if branch != nil {
			review.CommentBranch = *branch
		}
	}
	if selection.Commit != "" {
		review.Commit, err = r.commitDetail(ctx, selection.Commit)
		if err != nil {
			return nil, err
		}
		if review.Commit == nil {
			notice := fmt.Sprintf("commit %s no longer resolves — showing every commit", selection.Commit)
			review.Notice = &notice
		}
	}
	before := ""
	if review.Commit != nil {
		tip = review.Commit.SHA
		if len(review.Commit.Parents) > 0 {
			before = review.Commit.Parents[0]
		} else {
			before, err = r.text(ctx, "hash-object", "-t", "tree", "--stdin")
			if err != nil {
				return nil, err
			}
		}
		review.Range = before + ".." + tip
	} else {
		before, err = r.text(ctx, "merge-base", baseSHA, tip)
		if err != nil {
			return nil, fmt.Errorf("Base and target have no merge-base: %w", err)
		}
		review.Range = resolution.Ref + ".." + target
	}
	review.Comparison.Before = before
	if selection.Committed || selection.Target != "" || review.Commit != nil {
		review.Comparison.After = &tip
	}
	// Explicit prefixes override diff.noprefix, diff.mnemonicPrefix and diff.srcPrefix.
	args := []string{"diff", "-M", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", before}
	if selection.IgnoreWhitespace {
		args = append(args, "--ignore-all-space")
	}
	if review.Comparison.After != nil {
		args = append(args, *review.Comparison.After)
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
	if automatic && review.Comparison.After == nil {
		paths, err := r.git(ctx, 256*1024*1024, "ls-files", "--others", "--exclude-standard", "-z")
		if err != nil {
			return nil, err
		}
		if len(paths) > 0 {
			for _, path := range strings.Split(string(paths), "\x00") {
				// Git represents embedded repositories/worktrees as directory
				// entries ending in '/'. They are outside this repository's diff.
				if path != "" && !strings.HasSuffix(path, "/") {
					review.Untracked = append(review.Untracked, path)
				}
			}
			if selection.IncludeUntracked && len(review.Untracked) > 0 {
				patch, files, err := r.untrackedPatch(ctx, review.Untracked)
				if err != nil {
					return nil, err
				}
				review.Patch += patch
				review.Files = append(review.Files, files...)
				review.UntrackedIncluded = true
			}
		}
	}
	review.parseSections(previous)
	for i := range review.Files {
		file := &review.Files[i]
		if s := review.sections[file.Path]; s != nil {
			identity := s.patch
			if selection.IgnoreWhitespace {
				identity = "ignore-whitespace\n" + identity
			}
			hash := sha1.Sum([]byte(identity))
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

// Retained for the untracked snapshot writer; errors use context terminology.
func (r Repository) readWorktree(path string) ([]byte, os.FileMode, error) {
	source, err := r.worktreeFile(path)
	if err != nil {
		return nil, 0, sourceError(err, false)
	}
	return source.data, source.mode, nil
}
func (r Repository) readText(ctx context.Context, revision *string, path string) (*TextFile, error) {
	source, err := r.fileSource(ctx, revision, path)
	if err != nil {
		return nil, sourceError(err, false)
	}
	data, err := source.read(ctx)
	if err != nil {
		return nil, err
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
	absent := old && (stat.Status == "added" || stat.Status == "untracked") || !old && stat.Status == "deleted"
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
		if n < 1 || n > len(lines) || (lines[n-1] != text && !(r.ignoreWhitespace && equalIgnoringWhitespace(lines[n-1], text))) {
			return nil, changed()
		}
	}
	r.sources[key] = file
	return file, nil
}
func (r *Review) Context(ctx context.Context, path, hash string) (*DiffFiles, error) {
	// Check identity before requiring a text source: a disappeared file is a
	// stale request too, matching the Node context contract.
	current := false
	for _, file := range r.Files {
		if file.Path == path && file.Hash != nil && *file.Hash == hash {
			current = true
			break
		}
	}
	if !current {
		return nil, changed()
	}
	stat, s, err := r.describe(path)
	if err != nil {
		return nil, err
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
		if old.Contents != now.Contents && !(r.ignoreWhitespace && equalIgnoringWhitespace(old.Contents, now.Contents)) {
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
	// A -w patch uses the new side's whitespace for shared context. Anchors
	// must read the actual selected side rather than that normalized context.
	if result != nil && !r.ignoreWhitespace {
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

// Match Git -w's horizontal whitespace handling without ignoring line breaks.
func equalIgnoringWhitespace(a, b string) bool {
	strip := func(s string) string {
		return strings.Map(func(c rune) rune {
			switch c {
			case ' ', '\t', '\r', '\v', '\f':
				return -1
			}
			return c
		}, s)
	}
	return strip(a) == strip(b)
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
