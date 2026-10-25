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

func TestURLBaseChoiceAndClearing(t *testing.T) {
	s := testServer(t)
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
		t.Fatal("the override outlived its URL")
	}
	// A base that older releases remembered in Git configuration no longer applies.
	gitFixture(t, s.repo.Path, "config", "branch.feature.ghlBase", "HEAD")
	gitFixture(t, s.repo.Path, "config", "branch.main.ghlBase", "HEAD")
	for _, query := range []string{"", "?target=main"} {
		w = api(t, s, "GET", "diff"+query, nil)
		requireStatus(t, w, 200)
		_ = json.Unmarshal(w.Body.Bytes(), &payload)
		if payload.Base.Ref == "HEAD" {
			t.Fatalf("a stored base answered diff%s", query)
		}
	}
	requireStatus(t, api(t, s, "GET", "diff", nil), 200)
	requireStatus(t, api(t, s, "GET", "refs", nil), 200)
	requireStatus(t, api(t, s, "GET", "commits", nil), 200)
	for _, query := range []string{"target=", "target=-bad", "commit=", "commit=-bad", "base="} {
		requireStatus(t, api(t, s, "GET", "diff?"+query, nil), 400)
	}
	requireStatus(t, api(t, s, "GET", "diff?target=missing", nil), 422)
	requireStatus(t, api(t, s, "GET", "commits?target=missing", nil), 422)
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

func TestOutdatedLocalTrunk(t *testing.T) {
	r := fixture(t)
	ctx := context.Background()
	gitFixture(t, r.Path, "stash", "push", "-qu")
	original := gitFixture(t, r.Path, "rev-parse", "main")
	gitFixture(t, r.Path, "update-ref", "refs/remotes/origin/main", "main")
	gitFixture(t, r.Path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	assertTrunk := func(want string) {
		t.Helper()
		got, err := r.trunk(ctx)
		if err != nil || got == nil || *got != want {
			t.Fatalf("trunk=%v want=%s err=%v", got, want, err)
		}
	}
	assertTrunk("main")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	writeFixture(t, r.Path, "integrated.txt", "already integrated\n")
	gitFixture(t, r.Path, "add", "integrated.txt")
	gitFixture(t, r.Path, "commit", "-qm", "already integrated")
	gitFixture(t, r.Path, "update-ref", "refs/remotes/origin/main", "main")
	gitFixture(t, r.Path, "checkout", "-q", "feature")
	gitFixture(t, r.Path, "merge", "-q", "origin/main", "-m", "update feature")
	gitFixture(t, r.Path, "branch", "-f", "main", original)
	assertTrunk("origin/main")

	base, err := r.resolveBase(ctx, "", "")
	if err != nil || base.Ref != "origin/main" || base.Source != "trunk" {
		t.Fatalf("outdated trunk: %+v %v", base, err)
	}
	commits, err := r.commits(ctx, base.Ref, "feature")
	if err != nil {
		t.Fatal(err)
	}
	foundFeature := false
	for _, commit := range commits {
		foundFeature = foundFeature || commit.Subject == "feature"
		if commit.Subject == "already integrated" {
			t.Fatal("already integrated commit leaked into the review")
		}
	}
	if !foundFeature {
		t.Fatal("feature commit missing from the review")
	}
	review, err := r.Resolve(ctx, Selection{Target: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	if len(review.Files) != 4 {
		t.Fatalf("expected only feature changes, got %+v", review.Files)
	}
	for _, file := range review.Files {
		if file.Path == "integrated.txt" {
			t.Fatal("already integrated change leaked into the diff")
		}
	}
	base, err = r.resolveBase(ctx, "main", "")
	if err != nil || base.Ref != "main" || base.Source != "override" {
		t.Fatalf("explicit local base: %+v %v", base, err)
	}
	writeFixture(t, r.GitDir, "gh-stack", `{"schemaVersion":1,"stacks":[{"trunk":{"branch":"main"},"branches":[{"branch":"feature"}]}]}`)
	base, err = r.resolveBase(ctx, "", "")
	if err != nil || base.Ref != "origin/main" || base.Source != "stack" || base.Stack == nil || base.Stack.Trunk != "origin/main" || base.Stack.Layers[0].Base != "origin/main" {
		t.Fatalf("stack with outdated trunk: %+v %v", base, err)
	}
	gitFixture(t, r.Path, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD")
	assertTrunk("origin/main")
	gitFixture(t, r.Path, "checkout", "-q", "main")
	gitFixture(t, r.Path, "commit", "-q", "--allow-empty", "-m", "local trunk work")
	assertTrunk("main")
	gitFixture(t, r.Path, "merge", "-q", "origin/main", "-m", "bring trunk up to date")
	assertTrunk("main")
	gitFixture(t, r.Path, "update-ref", "-d", "refs/remotes/origin/main")
	assertTrunk("main")
}

func TestGitFailuresAreNotAbsentValues(t *testing.T) {
	ctx := context.Background()
	r := fixture(t)
	if sha, err := r.resolveRef(ctx, "missing"); sha != "" || err != nil {
		t.Fatalf("missing ref: %q %v", sha, err)
	}
	// A moved or deleted checkout is a failure, not a ref that does not exist.
	if err := os.RemoveAll(r.GitDir); err != nil {
		t.Fatal(err)
	}
	if sha, err := r.resolveRef(ctx, "main"); err == nil {
		t.Fatalf("broken repository read as a missing ref: %q", sha)
	}
}

// The guess is cached per repository: a new branch tip must still change it.
func TestBaseGuessFollowsBranchTips(t *testing.T) {
	ctx := context.Background()
	r := fixture(t)
	gitFixture(t, r.Path, "checkout", "-qb", "top")
	gitFixture(t, r.Path, "commit", "--allow-empty", "-qm", "one")
	gitFixture(t, r.Path, "commit", "--allow-empty", "-qm", "two")
	trunk := "main"
	for _, want := range []struct {
		branch, base string
		distance     int
	}{{"", "feature", 2}, {"", "feature", 2}, {"middle", "middle", 1}} {
		if want.branch != "" {
			gitFixture(t, r.Path, "branch", want.branch, "top~1")
		}
		if base, distance, err := r.guessParent(ctx, "top", &trunk); err != nil || base != want.base || distance != want.distance {
			t.Fatalf("guess %q at %d (%v), want %q at %d", base, distance, err, want.base, want.distance)
		}
	}
}
