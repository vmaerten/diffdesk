package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Selection is URL-backed. An absent base invokes automatic resolution.
type Selection struct {
	Base, Target, Commit string
	Committed            bool
}

func (r Repository) optionalText(ctx context.Context, args ...string) (string, error) {
	value, err := r.text(ctx, args...)
	var exited *exec.ExitError
	if ctx.Err() == nil && errors.As(err, &exited) && (exited.ExitCode() == 1 || exited.ExitCode() == 128) {
		return "", nil
	}
	return value, err
}
func (r Repository) resolveRef(ctx context.Context, ref string) (string, error) {
	if !validRef(ref) {
		return "", fmt.Errorf("Invalid revision %q", ref)
	}
	return r.optionalText(ctx, "rev-parse", "--quiet", "--verify", "--end-of-options", ref+"^{commit}")
}
func (r Repository) currentBranch(ctx context.Context) (*string, error) {
	name, err := r.optionalText(ctx, "symbolic-ref", "--quiet", "--short", "HEAD")
	if name == "" {
		return nil, err
	}
	return &name, err
}
func (r Repository) refs(ctx context.Context) ([]RefDetail, error) {
	raw, err := r.text(ctx, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:relative)", "refs/heads")
	refs := []RefDetail{}
	for _, line := range strings.Split(raw, "\n") {
		if parts := strings.SplitN(line, "\t", 2); len(parts) == 2 {
			refs = append(refs, RefDetail{parts[0], parts[1]})
		}
	}
	return refs, err
}
func (r Repository) branches(ctx context.Context) ([]string, error) {
	raw, err := r.text(ctx, "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if raw == "" {
		return []string{}, err
	}
	return strings.Split(raw, "\n"), err
}
func (r Repository) trunk(ctx context.Context) (*string, error) {
	origin, err := r.optionalText(ctx, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
	if err != nil {
		return nil, err
	}
	candidates := []string{"main", "master", "develop", "origin/main", "origin/master", "origin/develop"}
	if origin != "" {
		origin = strings.TrimPrefix(origin, "refs/remotes/")
		candidates = append([]string{strings.TrimPrefix(origin, "origin/"), origin}, candidates...)
	}
	for _, name := range candidates {
		sha, err := r.resolveRef(ctx, name)
		if err != nil {
			return nil, err
		}
		if sha != "" {
			return &name, nil
		}
	}
	return nil, nil
}

func (r Repository) stack(ctx context.Context, branch, trunk *string) (*StackChain, error) {
	if branch == nil {
		return nil, nil
	}
	common, err := r.text(ctx, "rev-parse", "--git-common-dir")
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(r.Path, common)
	}
	var file struct {
		SchemaVersion int `json:"schemaVersion"`
		Stacks        []struct {
			Trunk struct {
				Branch string `json:"branch"`
			} `json:"trunk"`
			Branches []struct {
				Branch      string `json:"branch"`
				PullRequest *struct {
					Number *int   `json:"number"`
					URL    string `json:"url"`
					Merged bool   `json:"merged"`
				} `json:"pullRequest"`
			} `json:"branches"`
		} `json:"stacks"`
	}
	readable := false
	for _, dir := range []string{r.GitDir, common} {
		f, err := os.Open(filepath.Join(dir, "gh-stack"))
		if err != nil {
			continue
		}
		decoder := json.NewDecoder(io.LimitReader(f, 2*1024*1024))
		file.SchemaVersion = 0
		file.Stacks = nil
		err = decoder.Decode(&file)
		if err == nil {
			err = decoder.Decode(new(any))
			if err == io.EOF {
				err = nil
			} else if err == nil {
				err = fmt.Errorf("Unexpected stack data")
			}
		}
		f.Close()
		if err != nil {
			continue
		}
		if file.SchemaVersion != 1 {
			return nil, nil
		}
		readable = true
		break
	}
	if !readable {
		return nil, nil
	}
	for _, recorded := range file.Stacks {
		current := -1
		for i, layer := range recorded.Branches {
			if layer.Branch == *branch {
				current = i
				break
			}
		}
		if current < 0 || !validRef(recorded.Trunk.Branch) {
			continue
		}
		below := recorded.Trunk.Branch
		if trunk != nil && strings.HasSuffix(*trunk, "/"+below) {
			below = *trunk
		}
		chain := &StackChain{Trunk: below, Layers: []StackLayer{}, Current: -1}
		live, err := r.branches(ctx)
		if err != nil {
			return nil, err
		}
		for _, entry := range recorded.Branches {
			if !validRef(entry.Branch) {
				continue
			}
			layer := StackLayer{Branch: entry.Branch, Base: below}
			for _, name := range live {
				if name == entry.Branch {
					layer.Exists = true
					break
				}
			}
			if pr := entry.PullRequest; pr != nil {
				layer.Merged = pr.Merged
				if pr.Number != nil && pr.URL != "" {
					layer.PR = &StackPR{*pr.Number, pr.URL}
				}
			}
			if layer.Branch == *branch {
				chain.Current = len(chain.Layers)
			}
			chain.Layers = append(chain.Layers, layer)
			if layer.Exists && !layer.Merged {
				below = layer.Branch
			}
		}
		return chain, nil
	}
	return nil, nil
}

func (r Repository) guessParent(ctx context.Context, head string, trunk *string) (string, int, error) {
	headSHA, err := r.resolveRef(ctx, head)
	if err != nil || headSHA == "" {
		return "", 0, err
	}
	names, err := r.branches(ctx)
	if err != nil {
		return "", 0, err
	}
	if trunk != nil {
		found := false
		for _, name := range names {
			found = found || name == *trunk
		}
		if !found {
			names = append(names, *trunk)
		}
	}
	type score struct {
		distance int
		valid    bool
		err      error
	}
	scores := make([]score, len(names))
	jobs := make(chan int)
	var wg sync.WaitGroup
	workers := max(4, runtime.GOMAXPROCS(0)*2)
	for range min(workers, len(names)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				name := names[i]
				if name == head {
					continue
				}
				base, err := r.optionalText(ctx, "merge-base", headSHA, name)
				if err != nil {
					scores[i].err = err
					continue
				}
				if base == "" {
					continue
				}
				if base == headSHA {
					if trunk != nil && name == *trunk {
						scores[i].valid = true
					}
					continue
				}
				raw, err := r.text(ctx, "rev-list", "--count", base+".."+headSHA)
				distance, parseErr := strconv.Atoi(raw)
				if err == nil {
					err = parseErr
				}
				scores[i] = score{distance, distance > 0 && err == nil, err}
			}
		}()
	}
	for i := range names {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	best, distance := "", int(^uint(0)>>1)
	trunkDistance := -1
	for i, score := range scores {
		if score.err != nil {
			return "", 0, score.err
		}
		if !score.valid {
			continue
		}
		if trunk != nil && names[i] == *trunk {
			trunkDistance = score.distance
		}
		if score.distance < distance {
			best, distance = names[i], score.distance
		}
	}
	if trunkDistance >= 0 && distance >= trunkDistance {
		return *trunk, trunkDistance, nil
	}
	return best, distance, nil
}
func (r Repository) resolveBase(ctx context.Context, override, target string) (BaseResolution, error) {
	branch, err := r.currentBranch(ctx)
	if err != nil {
		return BaseResolution{}, err
	}
	if target != "" {
		branch = &target
	}
	return r.baseFor(ctx, override, branch)
}
func (r Repository) baseFor(ctx context.Context, override string, branch *string) (BaseResolution, error) {
	trunk, err := r.trunk(ctx)
	if err != nil {
		return BaseResolution{}, err
	}
	stack, err := r.stack(ctx, branch, trunk)
	if err != nil {
		return BaseResolution{}, err
	}
	base := BaseResolution{Branch: branch, Trunk: trunk, Stack: stack}
	if override != "" {
		sha, err := r.resolveRef(ctx, override)
		if err != nil {
			return base, err
		}
		if sha == "" {
			return base, fmt.Errorf("Invalid base %q: does not resolve to a revision", override)
		}
		base.Ref, base.Source = override, "override"
		return base, nil
	}
	if branch != nil {
		remembered, err := r.optionalText(ctx, "config", "--get", "branch."+*branch+".ghlBase")
		if err != nil {
			return base, err
		}
		if validRef(remembered) {
			sha, err := r.resolveRef(ctx, remembered)
			if err != nil {
				return base, err
			}
			if sha != "" {
				base.Ref, base.Source = remembered, "remembered"
				return base, nil
			}
		}
	}
	if stack != nil && stack.Current >= 0 {
		base.Ref, base.Source = stack.Layers[stack.Current].Base, "stack"
		return base, nil
	}
	onTrunk := trunk != nil && branch != nil && (*branch == *trunk || *branch == strings.TrimPrefix(*trunk, "origin/"))
	if branch != nil && !onTrunk {
		ref, distance, err := r.guessParent(ctx, *branch, trunk)
		if err != nil {
			return base, err
		}
		if ref != "" && (trunk == nil || ref != *trunk) {
			base.Ref, base.Source, base.Distance = ref, "guessed", &distance
			return base, nil
		}
	}
	if trunk != nil {
		base.Ref, base.Source = *trunk, "trunk"
		return base, nil
	}
	return base, fmt.Errorf("No base found: set one with --base, or define origin/HEAD")
}
func (r Repository) rememberBase(ctx context.Context, branch *string, base string) error {
	if branch == nil {
		return fmt.Errorf("Cannot remember a base while HEAD is detached")
	}
	if !validRef(*branch) {
		return fmt.Errorf("Invalid target ref")
	}
	sha, err := r.resolveRef(ctx, base)
	if err != nil {
		return err
	}
	if sha == "" {
		return fmt.Errorf("Invalid base %q", base)
	}
	_, err = r.text(ctx, "config", "--local", "--replace-all", "branch."+*branch+".ghlBase", base)
	return err
}

const commitFormat = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%P"

var shortStatRE = regexp.MustCompile(`(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?`)

func parseCommits(raw string) []CommitDetail {
	commits := []CommitDetail{}
	for _, line := range strings.Split(raw, "\n") {
		if parts := strings.Split(line, "\x1f"); len(parts) == 6 {
			commits = append(commits, CommitDetail{SHA: parts[0], Short: parts[1], Subject: parts[2], Author: parts[3], When: parts[4], Parents: strings.Fields(parts[5])})
			if commits[len(commits)-1].Parents == nil {
				commits[len(commits)-1].Parents = []string{}
			}
		} else if stat := shortStatRE.FindStringSubmatch(line); stat != nil && len(commits) > 0 {
			values := [3]int{}
			for i := range values {
				values[i], _ = strconv.Atoi(stat[i+1])
			}
			last := &commits[len(commits)-1]
			last.Files, last.Additions, last.Deletions = &values[0], &values[1], &values[2]
		}
	}
	return commits
}
func (r Repository) commits(ctx context.Context, base, target string) ([]CommitDetail, error) {
	from, err := r.resolveRef(ctx, base)
	if err != nil {
		return nil, err
	}
	to, err := r.resolveRef(ctx, target)
	if err != nil {
		return nil, err
	}
	if from == "" || to == "" {
		return nil, fmt.Errorf("Comparison no longer resolves; refresh to retry")
	}
	raw, err := r.text(ctx, "log", commitFormat, "--shortstat", "--no-color", from+".."+to, "--")
	return parseCommits(raw), err
}
func (r Repository) commitDetail(ctx context.Context, ref string) (*CommitDetail, error) {
	sha, err := r.resolveRef(ctx, ref)
	if err != nil || sha == "" {
		return nil, err
	}
	raw, err := r.text(ctx, "log", "-1", commitFormat, "--shortstat", "--no-color", sha, "--")
	if err != nil {
		return nil, err
	}
	commits := parseCommits(raw)
	if len(commits) == 0 {
		return nil, fmt.Errorf("Cannot read commit %s", sha)
	}
	return &commits[0], nil
}
