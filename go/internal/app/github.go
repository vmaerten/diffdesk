package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHub is reached through its CLI: ghl stores no token, and works with the
// hosts and accounts gh is signed in to.

// PullRequestStatus is what the title bar shows for a branch. GitHub is ready,
// missing (no gh), signed-out or unavailable (no GitHub remote, no network).
type PullRequestStatus struct {
	GitHub      string       `json:"github"`
	Message     string       `json:"message,omitempty"`
	PullRequest *PullRequest `json:"pullRequest"`
}

// GitHubAccount is who gh is signed in as, for the settings.
type GitHubAccount struct {
	GitHub  string `json:"github"`
	Message string `json:"message,omitempty"`
	Login   string `json:"login,omitempty"`
}

type PullRequest struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	// State is open, draft, merged or closed.
	State  string `json:"state"`
	Author string `json:"author"`
	Base   string `json:"base"`
	// Review is approved, changes-requested, required, or empty when the repository asks for none.
	Review             string   `json:"review"`
	ApprovedBy         []string `json:"approvedBy"`
	ChangesRequestedBy []string `json:"changesRequestedBy"`
	Requested          []string `json:"requested"`
	// Mergeable is mergeable, conflicting or unknown, while GitHub computes it.
	Mergeable string `json:"mergeable"`
	// Sync compares the local branch with the pull request's head; nil when
	// that head is not in the checkout. Only for open pull requests.
	Sync        *BranchSync `json:"sync"`
	Uncommitted bool        `json:"uncommitted"`
}

type BranchSync struct {
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
}

var (
	errGHMissing   = errors.New("The GitHub CLI is not installed")
	errGHSignedOut = errors.New("The GitHub CLI is not signed in")
	objectID       = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
)

// ghPath finds gh. The app opened from the Finder gets a PATH without the
// usual install places, so they are tried too. GHL_GH points tests at a fake.
func ghPath() (string, error) {
	if path := os.Getenv("GHL_GH"); path != "" {
		return path, nil
	}
	if path, err := exec.LookPath("gh"); err == nil {
		return path, nil
	}
	candidates := []string{"/opt/homebrew/bin/gh", "/usr/local/bin/gh"}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local/share/mise/shims/gh"), filepath.Join(home, ".local/bin/gh"))
	}
	for _, path := range candidates {
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return path, nil
		}
	}
	return "", errGHMissing
}

func gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	path, err := ghPath()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1")
	stdout := limitedBuffer{limit: 4 * 1024 * 1024}
	stderr := limitedBuffer{limit: 64 * 1024}
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("The GitHub CLI did not answer: %w", ctx.Err())
		}
		var exited *exec.ExitError
		// gh exits with 4 when it needs to authenticate.
		if errors.As(err, &exited) && exited.ExitCode() == 4 {
			return nil, errGHSignedOut
		}
		if line, _, _ := strings.Cut(strings.TrimSpace(stderr.buffer.String()), "\n"); line != "" {
			return nil, fmt.Errorf("gh: %s", line)
		}
		return nil, fmt.Errorf("gh: %w", err)
	}
	return stdout.buffer.Bytes(), nil
}

func gitHubState(err error) string {
	switch {
	case errors.Is(err, errGHMissing):
		return "missing"
	case errors.Is(err, errGHSignedOut):
		return "signed-out"
	}
	return "unavailable"
}

func gitHubAccount(ctx context.Context) GitHubAccount {
	raw, err := gh(ctx, "", "api", "user", "--jq", ".login")
	if err != nil {
		return GitHubAccount{GitHub: gitHubState(err), Message: err.Error()}
	}
	return GitHubAccount{GitHub: "ready", Login: strings.TrimSpace(string(raw))}
}

const pullRequestFields = "number,title,url,state,isDraft,author,baseRefName,headRefOid,reviewDecision,mergeable,reviewRequests,latestReviews"

type ghPullRequest struct {
	Number         int
	Title          string
	URL            string
	State          string
	IsDraft        bool
	Author         struct{ Login string }
	BaseRefName    string
	HeadRefOid     string
	ReviewDecision string
	Mergeable      string
	ReviewRequests []struct{ Login, Name string }
	LatestReviews  []struct {
		Author struct{ Login string }
		State  string
	}
}

func (p ghPullRequest) summary() PullRequest {
	pr := PullRequest{Number: p.Number, Title: p.Title, URL: p.URL, Author: p.Author.Login, Base: p.BaseRefName,
		ApprovedBy: []string{}, ChangesRequestedBy: []string{}, Requested: []string{}, Mergeable: strings.ToLower(p.Mergeable)}
	switch {
	case p.State == "OPEN" && p.IsDraft:
		pr.State = "draft"
	default:
		pr.State = strings.ToLower(p.State)
	}
	switch p.ReviewDecision {
	case "APPROVED":
		pr.Review = "approved"
	case "CHANGES_REQUESTED":
		pr.Review = "changes-requested"
	case "REVIEW_REQUIRED":
		pr.Review = "required"
	}
	for _, review := range p.LatestReviews {
		switch review.State {
		case "APPROVED":
			pr.ApprovedBy = append(pr.ApprovedBy, review.Author.Login)
		case "CHANGES_REQUESTED":
			pr.ChangesRequestedBy = append(pr.ChangesRequestedBy, review.Author.Login)
		}
	}
	for _, request := range p.ReviewRequests {
		// A team has a name and no login.
		if request.Login != "" {
			pr.Requested = append(pr.Requested, request.Login)
		} else if request.Name != "" {
			pr.Requested = append(pr.Requested, request.Name)
		}
	}
	return pr
}

// pullRequest finds the pull request whose head is the local branch, or its
// upstream branch when it pushes elsewhere: the open one, else the latest.
func (r Repository) pullRequest(ctx context.Context, branch string) (PullRequestStatus, error) {
	tip, err := r.optionalText(ctx, "rev-parse", "--quiet", "--verify", "--end-of-options", "refs/heads/"+branch+"^{commit}")
	if err != nil {
		return PullRequestStatus{}, err
	}
	if tip == "" {
		// Not a local branch: a tag, a commit or a remote ref has no pull request of its own.
		return PullRequestStatus{GitHub: "ready"}, nil
	}
	head := branch
	merge, err := r.optionalText(ctx, "config", "--get", "branch."+branch+".merge")
	if err != nil {
		return PullRequestStatus{}, err
	}
	if upstream, ok := strings.CutPrefix(merge, "refs/heads/"); ok {
		head = upstream
	}
	raw, err := gh(ctx, r.Path, "pr", "list", "--head", head, "--state", "all", "--limit", "20", "--json", pullRequestFields)
	if err != nil {
		return PullRequestStatus{GitHub: gitHubState(err), Message: err.Error()}, nil
	}
	var found []ghPullRequest
	if err := json.Unmarshal(raw, &found); err != nil {
		return PullRequestStatus{GitHub: "unavailable", Message: "Unexpected output from the GitHub CLI"}, nil
	}
	if len(found) == 0 {
		return PullRequestStatus{GitHub: "ready"}, nil
	}
	// gh lists the newest first.
	chosen := found[0]
	for _, candidate := range found {
		if candidate.State == "OPEN" {
			chosen = candidate
			break
		}
	}
	pr := chosen.summary()
	if pr.State == "open" || pr.State == "draft" {
		if pr.Sync, err = r.branchSync(ctx, chosen.HeadRefOid, tip); err != nil {
			return PullRequestStatus{}, err
		}
		if pr.Uncommitted, err = r.uncommitted(ctx, branch); err != nil {
			return PullRequestStatus{}, err
		}
	}
	return PullRequestStatus{GitHub: "ready", PullRequest: &pr}, nil
}

// branchSync counts the commits on each side of the pull request's head and
// the local tip, when the checkout has that head.
func (r Repository) branchSync(ctx context.Context, head, tip string) (*BranchSync, error) {
	if !objectID.MatchString(head) {
		return nil, nil
	}
	known, err := r.resolveRef(ctx, head)
	if err != nil || known == "" {
		return nil, err
	}
	counts, err := r.text(ctx, "rev-list", "--left-right", "--count", head+"..."+tip)
	if err != nil {
		return nil, err
	}
	behind, ahead, _ := strings.Cut(counts, "\t")
	sync := &BranchSync{}
	if sync.Behind, err = strconv.Atoi(behind); err != nil {
		return nil, fmt.Errorf("Unexpected commit count %q", counts)
	}
	if sync.Ahead, err = strconv.Atoi(ahead); err != nil {
		return nil, fmt.Errorf("Unexpected commit count %q", counts)
	}
	return sync, nil
}

// uncommitted says whether the branch is checked out with changes to tracked files.
func (r Repository) uncommitted(ctx context.Context, branch string) (bool, error) {
	current, err := r.currentBranch(ctx)
	if err != nil || current == nil || *current != branch {
		return false, err
	}
	status, err := r.text(ctx, "status", "--porcelain", "--untracked-files=no")
	return status != "", err
}
