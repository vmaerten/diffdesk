package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionSelectionsShareExactVersions(t *testing.T) {
	r := fixture(t)
	ctx := context.Background()
	whole, err := r.Resolve(ctx, Selection{})
	if err != nil {
		t.Fatal(err)
	}
	if whole.Resolution.Ref != "main" || whole.Resolution.Source != "trunk" || whole.Comparison.After != nil {
		t.Fatalf("wrong automatic review: %+v", whole.Resolution)
	}
	for _, selection := range []Selection{{Target: "feature"}, {Committed: true}, {Commit: whole.Head}} {
		review, err := r.Resolve(ctx, selection)
		if err != nil {
			t.Fatal(err)
		}
		if review.Comparison.After == nil || *review.Comparison.After != whole.Head {
			t.Fatal("revision included working tree")
		}
		for _, file := range review.Files {
			if file.Path == "staged.txt" {
				t.Fatal("staged work leaked into a revision")
			}
		}
	}
	root := gitFixture(t, r.Path, "rev-list", "--max-parents=0", "HEAD")
	review, err := r.Resolve(ctx, Selection{Commit: root})
	if err != nil {
		t.Fatal(err)
	}
	if review.Comparison.Before != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" || review.Range != review.Comparison.Before+".."+root || len(review.Commit.Parents) != 0 {
		t.Fatalf("root comparison: %+v", review)
	}
	f := statFor(t, review, "context.txt")
	files, err := review.Context(ctx, f.Path, *f.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if files.OldFile.Contents != "" || !strings.HasPrefix(files.NewFile.Contents, "line 1\n") {
		t.Fatal("root context read the checkout")
	}
	review, err = r.Resolve(ctx, Selection{Commit: "missing-commit"})
	if err != nil {
		t.Fatal(err)
	}
	if review.Commit != nil || review.Notice == nil || review.Range != whole.Range || review.Patch != whole.Patch {
		t.Fatal("missing commit did not fall back with notice")
	}
	for _, selection := range []Selection{{Target: "missing"}, {Base: "missing"}, {Target: "-bad"}, {Commit: "-bad"}, {Base: "HEAD:context.txt"}} {
		if _, err := r.Resolve(ctx, selection); err == nil {
			t.Fatalf("accepted invalid selection: %+v", selection)
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := r.Resolve(canceled, Selection{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("lost cancellation: %v", err)
	}
}

func TestRememberedChoicesAndURLClearing(t *testing.T) {
	s := testServer(t)
	s.base = "HEAD" // A CLI choice must not be a server-side fallback.
	w := api(t, s, "GET", "diff?base=HEAD", nil)
	requireStatus(t, w, 200)
	var payload struct {
		Base   BaseResolution `json:"base"`
		Target struct {
			WorkingTree bool `json:"workingTree"`
		} `json:"target"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Base.Ref != "HEAD" || payload.Base.Source != "override" {
		t.Fatal("lost URL override")
	}
	w = api(t, s, "GET", "diff", nil)
	requireStatus(t, w, 200)
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload.Base.Ref != "main" || payload.Base.Source != "trunk" {
		t.Fatal("registry answered after clearing the URL")
	}
	requireStatus(t, api(t, s, "POST", "base", map[string]any{"base": "HEAD", "target": "main"}), 200)
	if got := gitFixture(t, s.repo.Path, "config", "--get", "branch.main.ghlBase"); got != "HEAD" {
		t.Fatal("remembered against wrong branch")
	}
	w = api(t, s, "GET", "diff?target=main", nil)
	requireStatus(t, w, 200)
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload.Base.Source != "remembered" || payload.Base.Branch == nil || *payload.Base.Branch != "main" || payload.Target.WorkingTree {
		t.Fatal("target choice inherited checkout state")
	}
	w = api(t, s, "GET", "diff", nil)
	requireStatus(t, w, 200)
	_ = json.Unmarshal(w.Body.Bytes(), &payload)
	if payload.Base.Source != "trunk" {
		t.Fatal("another branch's choice leaked")
	}
	gitFixture(t, s.repo.Path, "config", "branch.feature.ghlBase", "missing")
	requireStatus(t, api(t, s, "GET", "diff", nil), 200)
	requireStatus(t, api(t, s, "GET", "refs", nil), 200)
	requireStatus(t, api(t, s, "GET", "commits", nil), 200)
	for _, query := range []string{"target=", "target=-bad", "commit=", "commit=-bad", "base="} {
		requireStatus(t, api(t, s, "GET", "diff?"+query, nil), 400)
	}
	requireStatus(t, api(t, s, "GET", "diff?target=missing", nil), 422)
	requireStatus(t, api(t, s, "GET", "commits?target=missing", nil), 422)
	requireStatus(t, api(t, s, "POST", "base", map[string]string{"base": "missing"}), 422)
	requireStatus(t, api(t, s, "POST", "base", map[string]string{"base": "main", "target": "missing"}), 422)
}

func TestStackWorktreePriorityAndCompatibility(t *testing.T) {
	r := fixture(t)
	linked := filepath.Join(t.TempDir(), "linked worktree é")
	gitFixture(t, r.Path, "worktree", "add", "-q", "-b", "stack/top", linked, "feature")
	worktree, err := openRepository(context.Background(), linked)
	if err != nil {
		t.Fatal(err)
	}
	common := `{"schemaVersion":1,"stacks":[{"trunk":{"branch":"main"},"branches":[{"branch":"feature"},{"branch":"stack/top"}]}]}`
	writeFixture(t, r.GitDir, "gh-stack", common)
	assertBase := func(ref, source string) {
		t.Helper()
		got, err := worktree.resolveBase(context.Background(), "", "")
		if err != nil || got.Ref != ref || got.Source != source {
			t.Fatalf("base=%+v err=%v", got, err)
		}
	}
	assertBase("feature", "stack")
	writeFixture(t, worktree.GitDir, "gh-stack", `{"schemaVersion":1,"stacks":[{"trunk":{"branch":"main"},"branches":[{"branch":"gone","pullRequest":{"merged":true}},{"branch":"stack/top"}]}]}`)
	assertBase("main", "stack")
	base, err := worktree.resolveBase(context.Background(), "", "")
	if err != nil || base.Stack.Current != 1 || base.Stack.Layers[0].Exists || !base.Stack.Layers[0].Merged {
		t.Fatal("missing merged layer was lost")
	}
	writeFixture(t, worktree.GitDir, "gh-stack", `{"schemaVersion":99,"stacks":[]}`)
	assertBase("main", "trunk") // The authoritative newer schema blocks legacy fallback.
	writeFixture(t, worktree.GitDir, "gh-stack", `{broken`)
	assertBase("feature", "stack")
	if err := os.Remove(filepath.Join(r.GitDir, "gh-stack")); err != nil {
		t.Fatal(err)
	}
	assertBase("main", "trunk")
}

func TestRemoteTrunkAndMissingBase(t *testing.T) {
	r := fixture(t)
	gitFixture(t, r.Path, "update-ref", "refs/remotes/origin/main", "main")
	gitFixture(t, r.Path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	gitFixture(t, r.Path, "branch", "-d", "main")
	base, err := r.resolveBase(context.Background(), "", "")
	if err != nil || base.Ref != "origin/main" || base.Source != "trunk" {
		t.Fatalf("remote trunk: %+v %v", base, err)
	}
	gitFixture(t, r.Path, "update-ref", "-d", "refs/remotes/origin/main")
	if _, err := r.Resolve(context.Background(), Selection{}); err == nil || !strings.Contains(err.Error(), "No base found") {
		t.Fatalf("silently chose a base: %v", err)
	}
}
