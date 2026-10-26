package app

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGH stands in for gh: it records its arguments and answers with output,
// on stderr too when it exits with a failure.
func fakeGH(t *testing.T, output string, exit int) (args func() []string) {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "gh")
	recorded := filepath.Join(dir, "args")
	body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %q\ncat <<'EOF'\n%s\nEOF\n", recorded, output)
	if exit != 0 {
		body = fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %q\necho %q >&2\nexit %d\n", recorded, output, exit)
	}
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DIFFDESK_GH", script)
	return func() []string {
		raw, err := os.ReadFile(recorded)
		if err != nil {
			return nil
		}
		return strings.Split(strings.TrimSpace(string(raw)), "\n")
	}
}

func pullRequestOf(t *testing.T, s *Server, branch string) PullRequestStatus {
	t.Helper()
	w := api(t, s, "GET", "pull-request?branch="+branch, nil)
	requireStatus(t, w, 200)
	var status PullRequestStatus
	if err := json.Unmarshal(w.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestPullRequestOfTheReviewedBranch(t *testing.T) {
	s := testServer(t)
	behind := gitFixture(t, s.repo.Path, "rev-parse", "feature~1")
	args := fakeGH(t, `[
		{"number": 9, "state": "CLOSED", "headRefOid": "`+behind+`"},
		{"number": 7, "title": "Widen the core", "url": "https://github.com/o/r/pull/7", "state": "OPEN", "isDraft": true,
		 "author": {"login": "alice"}, "baseRefName": "main", "headRefOid": "`+behind+`", "reviewDecision": "CHANGES_REQUESTED",
		 "mergeable": "CONFLICTING", "reviewRequests": [{"login": "carol"}, {"name": "core"}],
		 "latestReviews": [{"author": {"login": "bob"}, "state": "CHANGES_REQUESTED"}, {"author": {"login": "dan"}, "state": "COMMENTED"}],
		 "statusCheckRollup": [
			{"__typename": "CheckRun", "workflowName": "test", "name": "ui", "status": "COMPLETED", "conclusion": "SUCCESS", "startedAt": "2026-10-25T10:00:00Z", "detailsUrl": "https://ci/1"},
			{"__typename": "CheckRun", "workflowName": "test", "name": "ui", "status": "COMPLETED", "conclusion": "FAILURE", "startedAt": "2026-10-25T11:00:00Z", "detailsUrl": "https://ci/2"},
			{"__typename": "CheckRun", "workflowName": "build", "name": "desktop", "status": "IN_PROGRESS"},
			{"__typename": "CheckRun", "name": "docs", "status": "QUEUED"},
			{"__typename": "CheckRun", "name": "release", "status": "COMPLETED", "conclusion": "SKIPPED"},
			{"__typename": "StatusContext", "context": "deploy/netlify", "state": "SUCCESS", "targetUrl": "https://preview"}
		 ]}
	]`, 0)
	gitFixture(t, s.repo.Path, "config", "branch.feature.merge", "refs/heads/feature-on-github")

	status := pullRequestOf(t, s, "feature")
	pr := status.PullRequest
	if status.GitHub != "ready" || pr == nil || pr.Number != 7 {
		t.Fatalf("the open pull request should win over a newer closed one: %+v", status)
	}
	if pr.State != "draft" || pr.Review != "changes-requested" || pr.Mergeable != "conflicting" || pr.Author != "alice" || pr.Base != "main" {
		t.Fatalf("unexpected summary: %+v", pr)
	}
	if strings.Join(pr.ChangesRequestedBy, ",") != "bob" || len(pr.ApprovedBy) != 0 || strings.Join(pr.Requested, ",") != "carol,core" {
		t.Fatalf("unexpected reviewers: %+v", pr)
	}
	if pr.Sync == nil || pr.Sync.Ahead != 1 || pr.Sync.Behind != 0 || !pr.Uncommitted {
		t.Fatalf("the checked-out branch is a commit ahead, with uncommitted work: %+v %+v", pr.Sync, pr)
	}
	var checks []string
	for _, check := range pr.Checks {
		checks = append(checks, check.Name+"="+check.State+"@"+check.URL)
	}
	if strings.Join(checks, " ") != "test / ui=failed@https://ci/2 build / desktop=running@ docs=pending@ release=skipped@ deploy/netlify=passed@https://preview" || pr.Head != behind {
		t.Fatalf("a re-run should replace the earlier run, statuses should count as checks: %v on %s", checks, pr.Head)
	}
	if !strings.Contains(strings.Join(args(), " "), "--head feature-on-github") {
		t.Fatalf("the pull request's head is the branch the local one pushes to: %v", args())
	}

	// A head the checkout has never fetched cannot be compared.
	fakeGH(t, `[{"number": 7, "state": "OPEN", "headRefOid": "`+strings.Repeat("a", 40)+`"}]`, 0)
	if pr := pullRequestOf(t, s, "feature").PullRequest; pr == nil || pr.Sync != nil {
		t.Fatalf("an unknown head should leave the sync unknown: %+v", pr)
	}
}

func TestPullRequestWithoutGitHub(t *testing.T) {
	s := testServer(t)

	args := fakeGH(t, `[]`, 0)
	if status := pullRequestOf(t, s, "v1.0"); status.GitHub != "ready" || status.PullRequest != nil || args() != nil {
		t.Fatalf("a ref that is no local branch should not ask GitHub: %+v %v", status, args())
	}
	if status := pullRequestOf(t, s, "feature"); status.GitHub != "ready" || status.PullRequest != nil {
		t.Fatalf("a branch without a pull request: %+v", status)
	}

	fakeGH(t, "To get started with GitHub CLI, please run:  gh auth login", 4)
	if status := pullRequestOf(t, s, "feature"); status.GitHub != "signed-out" {
		t.Fatalf("gh exits with 4 when signed out: %+v", status)
	}

	fakeGH(t, "none of the git remotes configured for this repository point to a known GitHub host", 1)
	status := pullRequestOf(t, s, "feature")
	if status.GitHub != "unavailable" || !strings.Contains(status.Message, "known GitHub host") {
		t.Fatalf("gh's reason should reach the UI: %+v", status)
	}

	requireStatus(t, api(t, s, "GET", "pull-request?branch=-x", nil), 400)
}
