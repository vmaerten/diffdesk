package app

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

const commandHelp = `ghl — review the PR you are about to open, without opening it

Usage:
  ghl [target] [options]
  ghl comments [target] [options]

  target         Branch or revision; defaults to the checkout and working tree.
  comments       Export comments in this comparison as Markdown, or JSON with
                 --json. Use refs/heads/comments for a branch named "comments".

Options:
  --base <rev>   Compare against <rev> instead of the automatically resolved base
  --repo <path>  Review a repository (default: current directory)
  --print        Print a summary and exit without starting a server or browser
  --json         JSON comments, build metadata, or {port, repoId, url} at startup
  --port <n>     Loopback port (default: $GHL_PORT or 0 for an ephemeral port)
  --no-open      Do not open the browser
  --no-daemon    Stay in the foreground (currently the only runtime mode)
  --version      Print version and build metadata and exit
  -h, --help     Show this help on stdout

This runtime serves in the foreground. Shared daemon options are unavailable.
`

type commandArgs struct {
	repo, base, target                           string
	port                                         int
	noOpen, json, version, help, print, comments bool
}

func parseCommand(args []string, stderr io.Writer, options Options) (commandArgs, error) {
	cli := commandArgs{repo: "."}
	flags := flag.NewFlagSet(options.name(), flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	if options.PoC {
		cli.base = "HEAD"
		flags.SetOutput(stderr)
	} else if value := os.Getenv("GHL_PORT"); value != "" {
		port, err := strconv.Atoi(value)
		if err != nil || port < 0 || port > 65535 {
			return cli, fmt.Errorf("GHL_PORT expects a port between 0 and 65535, got: %s", value)
		}
		cli.port = port
	}
	flags.StringVar(&cli.repo, "repo", cli.repo, "Repository path")
	flags.StringVar(&cli.base, "base", cli.base, "Base ref")
	if options.PoC {
		flags.IntVar(&cli.port, "port", cli.port, "Loopback port, 0 chooses an ephemeral port")
	} else {
		flags.Func("port", "Loopback port, 0 chooses an ephemeral port", func(value string) error {
			port, err := strconv.Atoi(value)
			if err != nil || port < 0 || port > 65535 {
				return fmt.Errorf("expects a port between 0 and 65535, got: %s", value)
			}
			cli.port = port
			return nil
		})
	}
	flags.BoolVar(&cli.noOpen, "no-open", false, "Do not open the browser")
	flags.BoolVar(&cli.json, "json", false, "Print JSON")
	flags.BoolVar(&cli.version, "version", false, "Print version and build metadata")
	if options.PoC {
		if err := flags.Parse(args); err != nil {
			return cli, err
		}
		if flags.NArg() != 0 {
			return cli, fmt.Errorf("Unexpected argument %q; use --help", flags.Arg(0))
		}
	} else {
		flags.BoolVar(&cli.help, "help", false, "Show help")
		flags.BoolVar(&cli.help, "h", false, "Show help")
		flags.BoolVar(&cli.print, "print", false, "Print a summary")
		var foreground bool
		flags.BoolVar(&foreground, "no-daemon", false, "Stay in the foreground")
		if len(args) > 0 && args[0] == "comments" {
			cli.comments = true
			args = args[1:]
		}
		// Go's flag parser stops at the first positional argument. Collect flags
		// first so a target can precede, follow or sit between the options.
		ordered := []string{}
		positional := false
		for i := 0; i < len(args); i++ {
			arg := args[i]
			if arg == "--" && !positional {
				positional = true
				continue
			}
			if positional || !strings.HasPrefix(arg, "-") {
				if cli.target != "" || arg == "" {
					return cli, fmt.Errorf("Unexpected argument %q; only one target is allowed", arg)
				}
				cli.target = arg
				continue
			}
			name, _, inline := strings.Cut(strings.TrimLeft(arg, "-"), "=")
			if name == "idle" || name == "daemon" {
				return cli, fmt.Errorf("--%s requires a shared daemon, unavailable in this runtime; use --no-daemon to serve in the foreground", name)
			}
			f := flags.Lookup(name)
			if f == nil {
				return cli, fmt.Errorf("Unknown option %q; use --help", arg)
			}
			ordered = append(ordered, arg)
			if name == "base" || name == "repo" || name == "port" {
				if !inline {
					if i+1 == len(args) || strings.HasPrefix(args[i+1], "--") {
						return cli, fmt.Errorf("--%s needs a value", name)
					}
					i++
					ordered = append(ordered, args[i])
				}
			}
		}
		if err := flags.Parse(ordered); err != nil {
			return cli, err
		}
	}
	if cli.port < 0 || cli.port > 65535 {
		return cli, fmt.Errorf("--port expects a port between 0 and 65535, got: %d", cli.port)
	}
	return cli, nil
}
