package app

import (
	"context"
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
func (r Repository) untrackedPatch(ctx context.Context, paths []string) (string, []FileStat, error) {
	tmp, err := os.MkdirTemp("", "ghl-untracked-")
	if err != nil {
		return "", nil, err
	}
	defer os.RemoveAll(tmp)
	snapshot := Repository{Path: tmp}
	attributes := map[string]bool{}
	var patch strings.Builder
	files := []FileStat{}
	for _, path := range paths {
		if err := ctx.Err(); err != nil {
			return "", nil, err
		}
		source, err := r.worktreeFile(path)
		if err != nil {
			if imageType(path) != "" {
				// An unavailable preview still needs a tree/header entry. Do not
				// synthesize text lines or let Git read the unsafe/oversized source.
				files = append(files, FileStat{Path: path, Status: "untracked", Binary: true})
				continue
			}
			return "", nil, fmt.Errorf("Cannot include untracked file %q: %w", path, sourceError(err, false))
		}
		data, mode := source.data, source.mode
		// Git consults .gitattributes in each ancestor of the diffed path.
		for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
			attribute := filepath.Join(dir, ".gitattributes")
			if !attributes[attribute] {
				contents, _, err := r.readWorktree(attribute)
				if err != nil && !os.IsNotExist(err) {
					return "", nil, fmt.Errorf("Cannot read attributes %q: %w", attribute, err)
				}
				if err == nil {
					if err := writeSnapshot(tmp, attribute, contents, 0600); err != nil {
						return "", nil, err
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
			return "", nil, err
		}
		out, err := snapshot.gitOutput(ctx, 256*1024*1024, true,
			"--git-dir="+r.GitDir, "--work-tree="+tmp,
			"diff", "--no-index", "--numstat", "-p", "--no-color", "--no-ext-diff", "--", "/dev/null", path)
		if err != nil {
			return "", nil, err
		}
		// Keep attributes for later siblings; discard other snapshots as we go.
		if filepath.Base(path) != ".gitattributes" {
			if err := os.Remove(filepath.Join(tmp, path)); err != nil {
				return "", nil, err
			}
		}
		first, rest, ok := strings.Cut(string(out), "\n")
		if !ok {
			return "", nil, fmt.Errorf("Invalid Git untracked patch for %q", path)
		}
		counts := strings.SplitN(first, "\t", 3)
		if len(counts) != 3 {
			return "", nil, fmt.Errorf("Invalid Git untracked numstat for %q", path)
		}
		file := FileStat{Path: path, Status: "untracked", Binary: counts[0] == "-"}
		if !file.Binary {
			file.Additions, err = strconv.Atoi(counts[0])
			if err == nil {
				file.Deletions, err = strconv.Atoi(counts[1])
			}
			if err != nil {
				return "", nil, err
			}
		}
		chunk := strings.TrimLeft(rest, "\n")
		if chunk == "" {
			continue
		}
		if len(chunk) > 256*1024*1024-patch.Len() {
			return "", nil, fmt.Errorf("Untracked patch exceeds 256 MB")
		}
		patch.WriteString(chunk)
		files = append(files, file)
	}
	return patch.String(), files, nil
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
