package app

import (
	"context"
	"path/filepath"
	"strings"
)

// Only attached, available worktrees can provide local changes for a branch.
// Porcelain's NUL format preserves spaces, newlines and non-ASCII paths.
func (r Repository) branchWorktree(ctx context.Context, branch string) (*Repository, error) {
	raw, err := r.text(ctx, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	for _, record := range strings.Split(raw, "\x00\x00") {
		var path, ref string
		prunable := false
		for _, field := range strings.Split(record, "\x00") {
			switch {
			case strings.HasPrefix(field, "worktree "):
				path = strings.TrimPrefix(field, "worktree ")
			case strings.HasPrefix(field, "branch "):
				ref = strings.TrimPrefix(field, "branch ")
			case field == "prunable" || strings.HasPrefix(field, "prunable "):
				prunable = true
			}
		}
		if path == "" || ref != "refs/heads/"+branch || prunable {
			continue
		}
		worktree, err := openRepository(ctx, path)
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue // A worktree can disappear between listing and opening it.
		}
		current, err := worktree.currentBranch(ctx)
		if err != nil {
			return nil, err
		}
		if current != nil && *current == branch {
			common, err := r.commonGitDirectory(ctx)
			if err != nil {
				return nil, err
			}
			otherCommon, err := worktree.commonGitDirectory(ctx)
			if err != nil {
				return nil, err
			}
			if common == otherCommon {
				return &worktree, nil
			}
		}
	}
	return nil, nil
}

func (r Repository) commonGitDirectory(ctx context.Context) (string, error) {
	path, err := r.text(ctx, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(path)
}
