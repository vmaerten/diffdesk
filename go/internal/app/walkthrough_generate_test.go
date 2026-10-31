package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeAgent writes an executable named name into a new folder, for a PATH.
func fakeAgent(t *testing.T, name, script string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestGeneratedWalkthrough(t *testing.T) {
	ctx := context.Background()
	path := t.TempDir()
	gitFixture(t, path, "init", "-q", "-b", "main")
	gitFixture(t, path, "config", "user.name", "Fixture")
	gitFixture(t, path, "config", "user.email", "fixture@example.invalid")
	writeFixture(t, path, "code.txt", "one\n")
	gitFixture(t, path, "add", ".")
	gitFixture(t, path, "commit", "-qm", "base")
	gitFixture(t, path, "checkout", "-qb", "feature")
	writeFixture(t, path, "code.txt", "two\n")
	repo, err := openRepository(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	review, err := repo.Resolve(ctx, Selection{Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	generations := newWalkthroughGenerations()
	defer generations.close()
	generate := func(agent, dir string) generationStatus {
		t.Helper()
		env := []string{"PATH=" + dir + ":/usr/bin:/bin"}
		if err := generations.start(review, agent, env, path); err != nil {
			t.Fatal(err)
		}
		generations.wait(repo.GitDir, "feature")
		return generations.status(repo.GitDir, "feature", env)
	}

	// Claude Code answers with a JSON envelope, the document fenced inside it.
	prompt := filepath.Join(t.TempDir(), "prompt")
	claude := fakeAgent(t, "claude", `cat > `+prompt+`
printf '%s' '{"type":"result","is_error":false,"modelUsage":{"claude-test":{}},"result":"`+"```json\\n"+`{\"version\":1,\"title\":\"Tour\",\"chapters\":[{\"title\":\"Code\",\"stops\":[{\"title\":\"One becomes two\",\"summary\":\"s\",\"hunks\":[\"code.txt#1\"]}]}]}\n`+"```"+`"}'
`)
	if status := generate("claude", claude); status.Running != "" || status.Failed != nil || !status.Agents[0].Found || status.Agents[1].Found {
		t.Fatalf("claude: %+v", status)
	}
	if sent, _ := os.ReadFile(prompt); !strings.Contains(string(sent), "code.txt#1  +1 -1") || !strings.Contains(string(sent), "  +two") {
		t.Fatalf("the prompt lacks the hunks:\n%s", sent)
	}
	stored, err := readWalkthrough(walkthroughPath(repo.GitDir, "feature"))
	if err != nil || stored == nil || stored.Author != "Claude Code · claude-test" || stored.Walkthrough.Title != "Tour" {
		t.Fatalf("stored: %+v %v", stored, err)
	}

	// Codex leaves its last message in a file; an invalid document is kept out.
	codex := fakeAgent(t, "codex", `while [ $# -gt 0 ]; do [ "$1" = --output-last-message ] && out=$2; shift; done
cat > /dev/null
echo "working" >&2
printf '%s' '{"version":1,"title":"Other","chapters":[{"title":"C","stops":[{"title":"S","summary":"s","hunks":["code.txt#2"]}]}]}' > "$out"
`)
	status := generate("codex", codex)
	if status.Failed == nil || status.Failed.Agent != "Codex" || !strings.Contains(status.Failed.Log, `unknown hunk "code.txt#2"`) || !strings.Contains(status.Failed.Log, "working") {
		t.Fatalf("codex: %+v", status)
	}
	if stored, _ := readWalkthrough(walkthroughPath(repo.GitDir, "feature")); stored.Walkthrough.Title != "Tour" {
		t.Fatalf("an invalid reply replaced the walkthrough: %q", stored.Walkthrough.Title)
	}
	generations.cancel(repo.GitDir, "feature")
	if status := generations.status(repo.GitDir, "feature", nil); status.Failed != nil {
		t.Fatalf("the failure outlived its dismissal: %+v", status)
	}

	// Cancelling stops the CLI and whatever it spawned.
	slow := fakeAgent(t, "claude", "sleep 30 &\nwait\n")
	env := []string{"PATH=" + slow + ":/usr/bin:/bin"}
	if err := generations.start(review, "claude", env, path); err != nil {
		t.Fatal(err)
	}
	if status := generations.status(repo.GitDir, "feature", env); status.Running != "Claude Code" {
		t.Fatalf("running: %+v", status)
	}
	started := time.Now()
	generations.cancel(repo.GitDir, "feature")
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("cancel took %s", elapsed)
	}
	if status := generations.status(repo.GitDir, "feature", env); status.Running != "" || status.Failed != nil {
		t.Fatalf("after cancel: %+v", status)
	}

	if err := generations.start(review, "claude", []string{"PATH=/usr/bin:/bin"}, path); err == nil || !strings.Contains(err.Error(), "Claude Code is not installed") {
		t.Fatalf("without claude: %v", err)
	}
}
