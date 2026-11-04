package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
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
	case len(args) > 0 && args[0] == "walkthrough":
		return true, runWalkthrough(ctx, args[1:], cwd, stdout)
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

const walkthroughUsage = "usage: diffdesk walkthrough hunks|guide|set|show|clear; see diffdesk --help"

// runWalkthrough answers `diffdesk walkthrough <verb>`. Every verb but guide works
// on a comparison, chosen as for `diffdesk comments`.
func runWalkthrough(ctx context.Context, args []string, cwd string, stdout io.Writer) error {
	if len(args) == 0 {
		return fmt.Errorf(walkthroughUsage)
	}
	verb, rest := args[0], args[1:]
	if verb == "guide" {
		if len(rest) > 0 {
			return fmt.Errorf("diffdesk walkthrough guide takes no argument")
		}
		return app.WalkthroughGuide(stdout)
	}
	var source string
	if verb == "set" {
		source, rest = documentArgument(rest)
		if source == "" {
			return fmt.Errorf("usage: diffdesk walkthrough set <file|-> [target] [--repo <path>] [--base <ref>]")
		}
	}
	rest, jsonOutput := withoutFlag(rest, "--json")
	rest, code := withoutFlag(rest, "--code")
	if (jsonOutput || code) && verb != "hunks" {
		return fmt.Errorf("--json and --code apply to diffdesk walkthrough hunks")
	}
	request, err := parseLaunch(rest, cwd)
	if err != nil {
		return err
	}
	selection := app.Selection{Base: request.base, Target: request.target}
	switch verb {
	case "hunks":
		return app.WalkthroughHunks(ctx, request.repo, selection, jsonOutput, code, stdout)
	case "set":
		input := io.Reader(os.Stdin)
		if source != "-" {
			if !filepath.IsAbs(source) {
				source = filepath.Join(cwd, source)
			}
			file, err := os.Open(source)
			if err != nil {
				return err
			}
			defer file.Close()
			input = file
		}
		return app.SetWalkthrough(ctx, request.repo, selection, input, stdout)
	case "show":
		return app.ShowWalkthrough(ctx, request.repo, selection, stdout)
	case "clear":
		return app.ClearWalkthrough(ctx, request.repo, selection, stdout)
	}
	return fmt.Errorf(walkthroughUsage)
}

// documentArgument takes set's first positional argument, the document, and
// leaves the comparison's arguments.
func documentArgument(args []string) (string, []string) {
	for i, arg := range args {
		value := i > 0 && (args[i-1] == "--repo" || args[i-1] == "--base")
		if !value && (arg == "-" || !strings.HasPrefix(arg, "-")) {
			return arg, append(append([]string{}, args[:i]...), args[i+1:]...)
		}
	}
	return "", args
}
