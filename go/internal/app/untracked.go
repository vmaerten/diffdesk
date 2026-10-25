package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Snapshot safe files before asking Git for no-index patches. Git never opens a
// checkout path that could have been replaced by a symlink or a special file.
// Relative names, executable bits, repository config and directory attributes
// preserve the regular-file patch contract without modifying the user's index.
// untrackedPatch also returns the files left out, each with the reason: one file
// Git must not read never takes the whole review or export down.
func (r Repository) untrackedPatch(ctx context.Context, paths []string) (string, []FileStat, []string, error) {
	tmp, err := os.MkdirTemp("", "diffdesk-untracked-")
	if err != nil {
		return "", nil, nil, err
	}
	defer os.RemoveAll(tmp)
	snapshot := Repository{Path: tmp}
	attributes := map[string]bool{}
	var patch strings.Builder
	files := []FileStat{}
	left := []string{}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return "", nil, nil, err
		}
		source, err := r.worktreeFile(path)
		if err != nil {
			if imageType(path) != "" {
				// An unavailable preview still needs a tree/header entry. Do not
				// synthesize text lines or let Git read the unsafe/oversized source.
				files = append(files, FileStat{Path: path, Status: "untracked", Binary: true})
				continue
			}
			if !errors.Is(err, os.ErrNotExist) {
				left = append(left, fmt.Sprintf("%s (%s)", path, leftOutReason(err)))
			}
			continue
		}
		data, mode := source.data, source.mode
		// Git consults .gitattributes in each ancestor of the diffed path.
		for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
			attribute := filepath.Join(dir, ".gitattributes")
			if !attributes[attribute] {
				contents, _, err := r.readWorktree(attribute)
				if err != nil && !os.IsNotExist(err) {
					return "", nil, nil, fmt.Errorf("Cannot read attributes %q: %w", attribute, err)
				}
				if err == nil {
					if err := writeSnapshot(tmp, attribute, contents, 0600); err != nil {
						return "", nil, nil, err
					}
				}
				attributes[attribute] = true
			}
			if dir == "." {
				break
			}
		}
		permissions := os.FileMode(0600)
		if mode&0111 != 0 {
			permissions = 0700
		}
		if err := writeSnapshot(tmp, path, data, permissions); err != nil {
			return "", nil, nil, err
		}
		out, err := snapshot.gitOutput(ctx, 256*1024*1024, true,
			"--git-dir="+r.GitDir, "--work-tree="+tmp,
			"diff", "--no-index", "--numstat", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", path)
		if err != nil {
			return "", nil, nil, err
		}
		// Keep attributes for later siblings; discard other snapshots as we go.
		if filepath.Base(path) != ".gitattributes" {
			if err := os.Remove(filepath.Join(tmp, path)); err != nil {
				return "", nil, nil, err
			}
		}
		first, rest, ok := strings.Cut(string(out), "\n")
		if !ok {
			return "", nil, nil, fmt.Errorf("Invalid Git untracked patch for %q", path)
		}
		counts := strings.SplitN(first, "\t", 3)
		if len(counts) != 3 {
			return "", nil, nil, fmt.Errorf("Invalid Git untracked numstat for %q", path)
		}
		file := FileStat{Path: path, Status: "untracked", Binary: counts[0] == "-"}
		if !file.Binary {
			file.Additions, err = strconv.Atoi(counts[0])
			if err == nil {
				file.Deletions, err = strconv.Atoi(counts[1])
			}
			if err != nil {
				return "", nil, nil, err
			}
		}
		chunk := strings.TrimLeft(rest, "\n")
		if chunk == "" {
			continue
		}
		if len(chunk) > 256*1024*1024-patch.Len() {
			return "", nil, nil, fmt.Errorf("Untracked patch exceeds 256 MB")
		}
		patch.WriteString(chunk)
		files = append(files, file)
	}
	return patch.String(), files, left, nil
}

func leftOutReason(err error) string {
	var failure fileFailure
	if errors.As(err, &failure) {
		switch failure {
		case "symlink", "non-regular-file":
			return "not a regular file"
		case "too-large":
			return "over 20 MB"
		case "changed":
			return "changed while reading"
		}
	}
	return err.Error()
}

func writeSnapshot(root, path string, data []byte, mode os.FileMode) error {
	name := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	if err := os.WriteFile(name, data, mode); err != nil {
		return err
	}
	return os.Chmod(name, mode)
}
