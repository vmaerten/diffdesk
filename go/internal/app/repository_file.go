package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

type fileFailure string

func (e fileFailure) Error() string { return string(e) }

var objectIDRE = regexp.MustCompile(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)

// Worktree bytes are captured immediately; immutable Git bytes can wait until
// requested. Context and previews share path, type and size checks.
type repositoryFile struct {
	repo     Repository
	size     int64
	objectID string
	mode     os.FileMode
	data     []byte
}

func (f *repositoryFile) read(ctx context.Context) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.objectID == "" {
		return f.data, nil
	}
	return f.repo.git(ctx, int(f.size)+1, "cat-file", "blob", f.objectID)
}

func (r Repository) fileSource(ctx context.Context, revision *string, path string) (*repositoryFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validPath(path) {
		return nil, fileFailure("invalid-path")
	}
	if revision == nil {
		return r.worktreeFile(path)
	}
	if !objectIDRE.MatchString(*revision) {
		return nil, fileFailure("invalid-revision")
	}
	entry, err := r.git(ctx, 64*1024, "--literal-pathspecs", "ls-tree", "-z", "-l", *revision, "--", path)
	if err != nil {
		return nil, err
	}
	parts := strings.SplitN(string(entry), "\t", 2)
	if len(parts) != 2 {
		return nil, fileFailure("non-regular-git")
	}
	fields := strings.Fields(parts[0])
	if len(fields) != 4 || (fields[0] != "100644" && fields[0] != "100755") || fields[1] != "blob" {
		return nil, fileFailure("non-regular-git")
	}
	size, err := strconv.ParseInt(fields[3], 10, 64)
	if err != nil || size < 0 {
		return nil, fmt.Errorf("Invalid Git blob size")
	}
	if size > maxTextBytes {
		return nil, fileFailure("too-large")
	}
	return &repositoryFile{repo: r, size: size, objectID: fields[2]}, nil
}

// OpenRoot confines racing parent symlinks to the repository; O_NOFOLLOW refuses
// a final symlink and O_NONBLOCK prevents a replaced FIFO from hanging a request.
func (r Repository) worktreeFile(path string) (*repositoryFile, error) {
	if !validPath(path) {
		return nil, fileFailure("invalid-path")
	}
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
		return nil, fileFailure("symlink")
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
		return nil, fileFailure("non-regular-file")
	}
	if stat.Size() > maxTextBytes {
		return nil, fileFailure("too-large")
	}
	data, err := io.ReadAll(io.LimitReader(file, stat.Size()+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != stat.Size() {
		return nil, fileFailure("changed")
	}
	return &repositoryFile{repo: r, size: int64(len(data)), mode: stat.Mode(), data: data}, nil
}

func sourceError(err error, image bool) error {
	var failure fileFailure
	if !errors.As(err, &failure) {
		return err
	}
	message := map[fileFailure]string{
		"invalid-path": "Unsupported file path", "invalid-revision": "Invalid revision",
		"symlink":          "Context is available only for regular files, not symlinks or special files",
		"non-regular-file": "Context is available only for regular files, not symlinks or special files",
		"non-regular-git":  "Context is available only for regular files",
		"too-large":        "File exceeds the 20 MB context limit", "changed": changed().Error(),
	}
	if image {
		message = map[fileFailure]string{
			"invalid-path": "Unsupported image path", "invalid-revision": "Invalid image revision",
			"symlink": "Symlink images are not previewed", "non-regular-file": "Not a regular image file",
			"non-regular-git": "Image is missing or is not a regular file",
			"too-large":       "Image exceeds the 20 MB preview limit", "changed": "Image changed while reading; refresh to retry",
		}
	}
	return fmt.Errorf("%s", message[failure])
}
