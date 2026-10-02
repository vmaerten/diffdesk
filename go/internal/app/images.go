package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

var imageTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
	".svg": "image/svg+xml", ".ico": "image/x-icon", ".bmp": "image/bmp",
}

func imageType(path string) string {
	extension := filepath.Ext(path)
	if extension == filepath.Base(path) {
		return ""
	}
	return imageTypes[strings.ToLower(extension)]
}

func (r Repository) imageSource(ctx context.Context, revision, path string) (*repositoryFile, error) {
	if imageType(path) == "" {
		return nil, fmt.Errorf("Unsupported image path")
	}
	var ref *string
	if revision != "worktree" {
		ref = &revision
	}
	source, err := r.fileSource(ctx, ref, path)
	return source, sourceError(err, true)
}

func digest(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (r Repository) imageVersion(ctx context.Context, repoID, revision, path string) *ImageVersion {
	source, err := r.imageSource(ctx, revision, path)
	if err != nil {
		return &ImageVersion{Error: err.Error(), Hash: "unavailable"}
	}
	hash := source.objectID
	if hash == "" {
		hash = digest(source.data)
	}
	// Match URLSearchParams' order and form encoding, including '~' and '*'.
	encode := func(value string) string {
		return strings.NewReplacer("~", "%7E", "%2A", "*").Replace(url.QueryEscape(value))
	}
	uri := "/r/" + repoID + "/api/image?revision=" + encode(revision) + "&path=" + encode(path) + "&v=" + hash
	// Keep only metadata; a pointer into source would retain its image bytes.
	size := source.size
	return &ImageVersion{URL: &uri, Bytes: &size, Hash: hash}
}

// Display identity follows image versions rather than text patch sections. It
// is applied only to the diff payload; comments/context keep their patch hashes.
func (r *Review) attachImages(ctx context.Context, repoID string) error {
	for i := range r.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		file := &r.Files[i]
		if imageType(file.Path) == "" {
			continue
		}
		image := &ImageComparison{}
		beforeHash, afterHash := "-", "-"
		if file.Status != "added" && file.Status != "untracked" {
			path := file.Path
			if section := r.sections[path]; section != nil {
				path = section.previous
			}
			image.Before = r.repo.imageVersion(ctx, repoID, r.Comparison.Before, path)
			beforeHash = image.Before.Hash
		}
		if file.Status != "deleted" {
			revision := "worktree"
			if r.Comparison.After != nil {
				revision = *r.Comparison.After
			}
			image.After = r.repo.imageVersion(ctx, repoID, revision, file.Path)
			afterHash = image.After.Hash
		}
		hash := digest([]byte(file.Path + "\x00" + beforeHash + "\x00" + afterHash))[:12]
		file.Image, file.Hash = image, &hash
	}
	return ctx.Err()
}
