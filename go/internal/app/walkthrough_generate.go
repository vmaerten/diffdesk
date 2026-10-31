package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// walkthroughAgent is a coding agent's CLI that can write a walkthrough. The
// page names one by its ID; the command never comes from the page.
type walkthroughAgent struct {
	ID, Label, Command string
}

var walkthroughAgents = []walkthroughAgent{
	{"claude", "Claude Code", "claude"},
	{"codex", "Codex", "codex"},
}

const (
	generationTimeout = 10 * time.Minute
	// Well under the agents' context windows, with room for the guide and the reply.
	maxGenerationPrompt = 512 * 1024
)

type generationAgent struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Found bool   `json:"found"`
}

type generationFailure struct {
	Agent string `json:"agent"`
	Log   string `json:"log"`
}

// generationStatus is what the page polls while a branch's walkthrough is written.
type generationStatus struct {
	Agents  []generationAgent  `json:"agents"`
	Running string             `json:"running,omitempty"`
	Failed  *generationFailure `json:"failed,omitempty"`
}

// generation is the one walkthrough being written for a branch, or the last that failed.
type generation struct {
	agent    walkthroughAgent
	cancel   context.CancelFunc
	done     chan struct{}
	log      tailBuffer
	err      error
	canceled bool
}

// walkthroughGenerations runs the agents writing walkthroughs, one at a time per branch.
type walkthroughGenerations struct {
	mu      sync.Mutex
	ctx     context.Context
	stop    context.CancelFunc
	closed  bool
	running map[string]*generation
}

func newWalkthroughGenerations() *walkthroughGenerations {
	ctx, stop := context.WithCancel(context.Background())
	return &walkthroughGenerations{ctx: ctx, stop: stop, running: map[string]*generation{}}
}

func generationKey(gitDir, branch string) string { return gitDir + "\x00" + branch }

func findAgent(id string) (walkthroughAgent, bool) {
	for _, agent := range walkthroughAgents {
		if agent.ID == id {
			return agent, true
		}
	}
	return walkthroughAgent{}, false
}

// generationPrompt carries everything the agent needs: it runs without tools.
func generationPrompt(review *Review, hunks []hunk) string {
	return walkthroughGuide + "\n# The change\n\nYou cannot run commands here: below is what `diffdesk walkthrough hunks --code` printed. Reply with the JSON document alone, without a code fence; Diffdesk validates and saves it.\n\n" + listHunks(hunks, review.Range, true)
}

// start has agentID write the review's walkthrough in the background, with
// env's PATH and dir as its working directory.
func (g *walkthroughGenerations) start(review *Review, agentID string, env []string, dir string) error {
	agent, ok := findAgent(agentID)
	if !ok {
		return fmt.Errorf("Unknown agent %q", agentID)
	}
	command := lookIn(environmentValue(env, "PATH"), agent.Command)
	if command == "" {
		return fmt.Errorf("%s is not installed: %s is not on your login shell's PATH", agent.Label, agent.Command)
	}
	hunks := review.hunks()
	if len(hunks) == 0 {
		return errors.New("There is nothing to walk through: the diff is empty")
	}
	prompt := generationPrompt(review, hunks)
	if len(prompt) > maxGenerationPrompt {
		return fmt.Errorf("This diff is too large to send: %d KB, %d KB at most", len(prompt)/1024, maxGenerationPrompt/1024)
	}
	key := generationKey(review.repo.GitDir, review.CommentBranch)
	g.mu.Lock()
	if g.closed {
		g.mu.Unlock()
		return errors.New("Diffdesk is quitting")
	}
	if job := g.running[key]; job != nil {
		select {
		case <-job.done:
		default:
			g.mu.Unlock()
			return fmt.Errorf("%s is already writing this walkthrough", job.agent.Label)
		}
	}
	ctx, cancel := context.WithTimeout(g.ctx, generationTimeout)
	job := &generation{agent: agent, cancel: cancel, done: make(chan struct{})}
	g.running[key] = job
	g.mu.Unlock()
	go func() {
		defer cancel()
		reply, author, err := agent.run(ctx, command, dir, env, prompt, &job.log)
		if err == nil {
			err = saveGenerated(review, hunks, reply, author)
		}
		g.mu.Lock()
		job.err = err
		if (err == nil || job.canceled) && g.running[key] == job {
			delete(g.running, key)
		}
		g.mu.Unlock()
		close(job.done)
	}()
	return nil
}

// run sends prompt to the agent's CLI and returns its reply, and the author to
// store: the agent, with its model when the CLI says. The CLI may read the
// checkout at most: it gets no tool that writes.
func (a walkthroughAgent) run(ctx context.Context, command, dir string, env []string, prompt string, log io.Writer) (string, string, error) {
	var args []string
	var lastMessage string
	switch a.ID {
	case "claude":
		// Safe mode leaves out the user's CLAUDE.md, skills, plugins and MCP
		// servers, which would otherwise add some 250k tokens to each run.
		args = []string{"-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
			"--safe-mode", "--strict-mcp-config", "--system-prompt", "You write walkthroughs of code changes for Diffdesk, and reply with JSON only."}
	case "codex":
		file, err := os.CreateTemp("", "diffdesk-walkthrough-*.txt")
		if err != nil {
			return "", "", err
		}
		file.Close()
		lastMessage = file.Name()
		defer os.Remove(lastMessage)
		args = []string{"exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--output-last-message", lastMessage, "-"}
	}
	var stdout bytes.Buffer
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir, cmd.Env, cmd.Stdin = dir, env, strings.NewReader(prompt)
	cmd.Stdout, cmd.Stderr = io.MultiWriter(&stdout, log), log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", fmt.Errorf("%s gave no walkthrough in %s", a.Label, generationTimeout)
		}
		return "", "", err
	}
	if lastMessage != "" {
		reply, err := os.ReadFile(lastMessage)
		return string(reply), a.Label, err
	}
	var result struct {
		Result     string         `json:"result"`
		IsError    bool           `json:"is_error"`
		ModelUsage map[string]any `json:"modelUsage"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return "", "", fmt.Errorf("%s printed no JSON result: %w", a.Label, err)
	}
	if result.IsError {
		return "", "", fmt.Errorf("%s failed: %s", a.Label, result.Result)
	}
	author := a.Label
	if len(result.ModelUsage) == 1 {
		for model := range result.ModelUsage {
			author += " · " + model
		}
	}
	return result.Result, author, nil
}

// saveGenerated validates the agent's reply like `walkthrough set` and saves it.
func saveGenerated(review *Review, hunks []hunk, reply, author string) error {
	// Agents wrap JSON in a fence or a sentence despite the guide.
	start, end := strings.Index(reply, "{"), strings.LastIndex(reply, "}")
	if start < 0 || end < start {
		return fmt.Errorf("The reply holds no JSON document:\n%s", reply)
	}
	w, err := decodeWalkthrough(strings.NewReader(reply[start : end+1]))
	if err != nil {
		return err
	}
	if problems := w.validate(hunks); len(problems) > 0 {
		return fmt.Errorf("The walkthrough is invalid:\n  %s", strings.Join(problems, "\n  "))
	}
	_, err = saveWalkthrough(review, hunks, w, author)
	return err
}

// cancel stops the branch's generation, or forgets its failure, and returns
// once its process has ended.
func (g *walkthroughGenerations) cancel(gitDir, branch string) {
	key := generationKey(gitDir, branch)
	g.mu.Lock()
	job := g.running[key]
	if job != nil {
		job.canceled = true
	}
	g.mu.Unlock()
	if job == nil {
		return
	}
	job.cancel()
	<-job.done
	g.mu.Lock()
	if g.running[key] == job {
		delete(g.running, key)
	}
	g.mu.Unlock()
}

// status says which agents env can run, and what the branch's generation is doing.
func (g *walkthroughGenerations) status(gitDir, branch string, env []string) generationStatus {
	path := environmentValue(env, "PATH")
	status := generationStatus{Agents: make([]generationAgent, 0, len(walkthroughAgents))}
	for _, agent := range walkthroughAgents {
		status.Agents = append(status.Agents, generationAgent{agent.ID, agent.Label, lookIn(path, agent.Command) != ""})
	}
	g.mu.Lock()
	job := g.running[generationKey(gitDir, branch)]
	g.mu.Unlock()
	if job == nil {
		return status
	}
	select {
	case <-job.done:
		if job.err != nil {
			log := job.err.Error()
			if tail := job.log.String(); tail != "" {
				log += "\n\n" + tail
			}
			status.Failed = &generationFailure{Agent: job.agent.Label, Log: log}
		}
	default:
		status.Running = job.agent.Label
	}
	return status
}

// close stops every generation; none starts afterwards.
func (g *walkthroughGenerations) close() {
	g.mu.Lock()
	g.closed = true
	jobs := make([]*generation, 0, len(g.running))
	for _, job := range g.running {
		jobs = append(jobs, job)
	}
	g.mu.Unlock()
	g.stop()
	for _, job := range jobs {
		<-job.done
	}
}

// wait is for tests: it returns once the branch's generation has ended.
func (g *walkthroughGenerations) wait(gitDir, branch string) {
	g.mu.Lock()
	job := g.running[generationKey(gitDir, branch)]
	g.mu.Unlock()
	if job != nil {
		<-job.done
	}
}
