package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/vmaerten/ghl/internal/app"
)

// runTerminal answers the commands that print instead of opening a window.
// It reports false for anything else, which then goes to the app.
func runTerminal(ctx context.Context, args []string, cwd string, stdout, stderr io.Writer) (bool, error) {
	switch {
	case len(args) > 1 && args[0] == "comments" && args[1] == "check":
		return true, check(ctx, args[2:], cwd, stdout, stderr)
	case len(args) > 1 && args[0] == "comments" && usages[args[1]] != "":
		return true, discuss(ctx, args[1], args[2:], cwd, stdout)
	case len(args) > 0 && args[0] == "comments":
		rest, jsonOutput := withoutFlag(args[1:], "--json")
		rest, all := withoutFlag(rest, "--all")
		request, err := parseLaunch(rest, cwd)
		if err != nil {
			return true, err
		}
		selection := app.Selection{Base: request.base, Target: request.target}
		return true, app.ExportComments(ctx, request.repo, selection, all, jsonOutput, stdout, stderr)
	case len(args) > 0 && args[0] == "--version":
		rest, jsonOutput := withoutFlag(args[1:], "--json")
		if len(rest) > 0 {
			return true, fmt.Errorf("--version takes no other option than --json")
		}
		info := app.Build()
		if jsonOutput {
			return true, json.NewEncoder(stdout).Encode(info)
		}
		_, err := fmt.Fprintf(stdout, "ghl %s (commit %s; built %s)\n", info.Version, info.Commit, info.BuildDate)
		return true, err
	}
	return false, nil
}

func withoutFlag(args []string, flag string) ([]string, bool) {
	rest := make([]string, 0, len(args))
	found := false
	for _, arg := range args {
		if arg == flag {
			found = true
		} else {
			rest = append(rest, arg)
		}
	}
	return rest, found
}

// exitStatus ends ghl with code, printing err first when there is one.
type exitStatus struct {
	code int
	err  error
}

func (e exitStatus) Error() string {
	if e.err == nil {
		return fmt.Sprintf("exit status %d", e.code)
	}
	return e.err.Error()
}

func (e exitStatus) Unwrap() error { return e.err }

// check exits like diff: 0 when nothing is open, 1 while comments are, 2 on an
// error, so a hook can tell an unanswered review from a failure.
func check(ctx context.Context, args []string, cwd string, stdout, stderr io.Writer) error {
	rest, jsonOutput := withoutFlag(args, "--json")
	rest, withCode := withoutFlag(rest, "--code")
	request, err := parseLaunch(rest, cwd)
	if err != nil {
		return exitStatus{2, err}
	}
	selection := app.Selection{Base: request.base, Target: request.target}
	open, err := app.CheckComments(ctx, request.repo, selection, jsonOutput, withCode, stdout, stderr)
	if err != nil {
		return exitStatus{2, err}
	}
	if open > 0 {
		return exitStatus{code: 1}
	}
	return nil
}

var usages = map[string]string{
	"reply":   "ghl comments reply <id> <message>",
	"resolve": "ghl comments resolve <id>",
	"reopen":  "ghl comments reopen <id> [<message>]",
}

// discuss runs reply, resolve or reopen. Words after the ID form the message,
// so an unquoted one still arrives whole.
func discuss(ctx context.Context, verb string, args []string, cwd string, stdout io.Writer) error {
	var flags, words []string
	for i := 0; i < len(args); i++ {
		switch arg := args[i]; {
		case arg == "--":
			words = append(words, args[i+1:]...)
			i = len(args)
		case (arg == "--repo" || arg == "--base") && i+1 < len(args):
			flags = append(flags, arg, args[i+1])
			i++
		case strings.HasPrefix(arg, "-"):
			flags = append(flags, arg)
		default:
			words = append(words, arg)
		}
	}
	request, err := parseLaunch(flags, cwd)
	if err != nil {
		return err
	}
	if request.base != "" {
		return fmt.Errorf("--base does not apply to %s", verb)
	}
	if len(words) == 0 || (verb == "resolve" && len(words) > 1) || (verb == "reply" && len(words) == 1) {
		return fmt.Errorf("usage: %s", usages[verb])
	}
	return app.DiscussComment(ctx, request.repo, verb, words[0], strings.Join(words[1:], " "), stdout)
}
