package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/vmaerten/ghl/internal/app"
)

// runTerminal answers the commands that print instead of opening a window.
// It reports false for anything else, which then goes to the app.
func runTerminal(ctx context.Context, args []string, cwd string, stdout, stderr io.Writer) (bool, error) {
	switch {
	case len(args) > 0 && args[0] == "comments":
		rest, jsonOutput := withoutFlag(args[1:], "--json")
		request, err := parseLaunch(rest, cwd)
		if err != nil {
			return true, err
		}
		selection := app.Selection{Base: request.base, Target: request.target}
		return true, app.ExportComments(ctx, request.repo, selection, jsonOutput, stdout, stderr)
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
