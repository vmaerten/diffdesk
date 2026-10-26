package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/vmaerten/diffdesk/internal/app"
)

// runTerminal answers the commands that print instead of opening a window.
// It reports false for anything else, which then goes to the app.
func runTerminal(ctx context.Context, args []string, cwd string, stdout, stderr io.Writer) (bool, error) {
	switch {
	case len(args) > 1 && args[0] == "comments" && (args[1] == "resolve" || args[1] == "reopen"):
		return true, setStatus(ctx, args[1], args[2:], cwd, stdout)
	case len(args) > 0 && args[0] == "comments":
		var options app.ExportOptions
		rest, jsonOutput := withoutFlag(args[1:], "--json")
		rest, all := withoutFlag(rest, "--all")
		rest, code := withoutFlag(rest, "--code")
		options.JSON, options.All, options.Code = jsonOutput, all, code
		request, err := parseLaunch(rest, cwd)
		if err != nil {
			return true, err
		}
		selection := app.Selection{Base: request.base, Target: request.target}
		return true, app.ExportComments(ctx, request.repo, selection, options, stdout, stderr)
	case len(args) > 0 && args[0] == "--version":
		rest, jsonOutput := withoutFlag(args[1:], "--json")
		if len(rest) > 0 {
			return true, fmt.Errorf("--version takes no other option than --json")
		}
		info := app.Build()
		if jsonOutput {
			return true, json.NewEncoder(stdout).Encode(info)
		}
		_, err := fmt.Fprintf(stdout, "diffdesk %s (commit %s; built %s)\n", info.Version, info.Commit, info.BuildDate)
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

// setStatus runs `diffdesk comments resolve <id>` or `reopen <id>`. The comment's
// ID is all it needs, so it takes no target and no base.
func setStatus(ctx context.Context, verb string, args []string, cwd string, stdout io.Writer) error {
	var id string
	var flags []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") || (len(flags) > 0 && flags[len(flags)-1] == "--repo") {
			flags = append(flags, arg)
		} else if id == "" {
			id = arg
		} else {
			return fmt.Errorf("usage: diffdesk comments %s <id> [--repo <path>]", verb)
		}
	}
	request, err := parseLaunch(flags, cwd)
	if err != nil {
		return err
	}
	if id == "" || request.base != "" {
		return fmt.Errorf("usage: diffdesk comments %s <id> [--repo <path>]", verb)
	}
	status := "resolved"
	if verb == "reopen" {
		status = "open"
	}
	return app.SetCommentStatus(ctx, request.repo, id, status, stdout)
}
