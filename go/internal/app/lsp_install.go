package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// installMethod is one way to install a language's server. The page names a
// method by its manager; the command itself never comes from the page.
type installMethod struct {
	Manager string
	Command []string
}

func (i installMethod) String() string { return strings.Join(i.Command, " ") }

// Global installs only: a click must not change the reviewed project's files.
func mise(tool string) installMethod {
	return installMethod{"mise", []string{"mise", "use", "-g", tool}}
}

func brew(formula string) installMethod {
	return installMethod{"Homebrew", []string{"brew", "install", formula}}
}

type installOption struct {
	Manager string `json:"manager"`
	Command string `json:"command"`
}

type installFailure struct {
	Manager string `json:"manager"`
	Log     string `json:"log"`
}

// installJob is the one install running, or the last that failed, for a language.
type installJob struct {
	manager string
	done    chan struct{}
	log     tailBuffer
	err     error
}

const installTimeout = 10 * time.Minute

// installs lists the methods whose manager the environment can run, in the
// language's order, and the command to show when none can.
func (l language) installs(env []string) ([]installOption, string) {
	path := environmentValue(env, "PATH")
	var available []installOption
	for _, method := range l.Installs {
		if lookIn(path, method.Command[0]) != "" {
			available = append(available, installOption{method.Manager, method.String()})
		}
	}
	if len(available) > 0 {
		return available, available[0].Command
	}
	if len(l.Installs) > 0 {
		return nil, l.Installs[len(l.Installs)-1].String()
	}
	return nil, ""
}

// install runs the language's method for manager in root's environment, in
// the background. One install runs at a time per language.
func (m *languageServers) install(root, languageID, manager string) error {
	l, ok := m.language(languageID)
	if !ok {
		return fmt.Errorf("Unknown language %q", languageID)
	}
	env := m.env(root)
	var method *installMethod
	for _, candidate := range l.Installs {
		if candidate.Manager == manager {
			method = &candidate
			break
		}
	}
	if method == nil {
		return fmt.Errorf("%s cannot install a %s language server", manager, l.Label)
	}
	command := lookIn(environmentValue(env, "PATH"), method.Command[0])
	if command == "" {
		return fmt.Errorf("%s is not installed", manager)
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errLSPClosed
	}
	if job := m.installing[languageID]; job != nil {
		select {
		case <-job.done:
		default:
			m.mu.Unlock()
			return fmt.Errorf("%s is already being installed", l.Label)
		}
	}
	job := &installJob{manager: manager, done: make(chan struct{})}
	m.installing[languageID] = job
	ctx, cancel := context.WithTimeout(m.installContext, installTimeout)
	m.mu.Unlock()
	go func() {
		defer cancel()
		cmd := exec.CommandContext(ctx, command, method.Command[1:]...)
		// The home folder, not the checkout: a project's own tool versions must
		// not decide where a global install goes.
		cmd.Dir, _ = os.UserHomeDir()
		cmd.Env, cmd.Stdout, cmd.Stderr = env, &job.log, &job.log
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
		cmd.WaitDelay = time.Second
		err := cmd.Run()
		// The server may sit in a folder the PATH gains only now, as a mise shim.
		m.forgetEnvironments()
		m.mu.Lock()
		job.err = err
		if err == nil && m.installing[languageID] == job {
			delete(m.installing, languageID)
		}
		m.mu.Unlock()
		close(job.done)
	}()
	return nil
}

func (m *languageServers) forgetEnvironments() {
	m.mu.Lock()
	entries := make([]*environmentEntry, 0, len(m.envs))
	for _, entry := range m.envs {
		entries = append(entries, entry)
	}
	m.mu.Unlock()
	for _, entry := range entries {
		entry.mu.Lock()
		entry.env = nil
		entry.mu.Unlock()
	}
}

// describeInstall adds the install running for the language, or the one that failed.
func (m *languageServers) describeInstall(entry *languageStatus) {
	m.mu.Lock()
	job := m.installing[entry.ID]
	m.mu.Unlock()
	if job == nil {
		return
	}
	select {
	case <-job.done:
		if job.err != nil {
			log := job.log.String()
			if log == "" {
				log = job.err.Error()
			}
			entry.InstallError = &installFailure{Manager: job.manager, Log: log}
		}
	default:
		entry.Installing = job.manager
	}
}

func (m *languageServers) stopInstalls() {
	m.cancelInstalls()
	m.mu.Lock()
	jobs := make([]*installJob, 0, len(m.installing))
	for _, job := range m.installing {
		jobs = append(jobs, job)
	}
	m.mu.Unlock()
	for _, job := range jobs {
		<-job.done
	}
}

// waitInstall is for tests: it returns once the language's install has ended.
func (m *languageServers) waitInstall(languageID string) {
	m.mu.Lock()
	job := m.installing[languageID]
	m.mu.Unlock()
	if job != nil {
		<-job.done
	}
}
