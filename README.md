# Diffdesk

Review the PR you are about to open, without opening it.

A local Git diff viewer for macOS with a GitHub-like review flow. Review branches, commits and working-tree changes in one native window, comment on lines, then copy the comments to an agent. It needs macOS 13 or later on Apple Silicon, and Git.

## Install

With [Homebrew](https://brew.sh/):

```bash
brew install --cask vmaerten/tap/diffdesk
```

With [mise](https://mise.jdx.dev/):

```bash
mise use -g github:vmaerten/diffdesk@latest
```

Both put the `diffdesk` command on PATH, and Homebrew also links `ghl`, its name before the app became Diffdesk. Homebrew installs `Diffdesk.app` in `/Applications`; mise keeps it in its own install directory. See the [installation guide](https://diffdesk.vmaerten.fr/guide/installation/) for upgrades, rollback and moving from the 0.2.0 browser CLI.

To install from source, with Node >= 24, pnpm, Go >= 1.25, Task v3 and the Xcode Command Line Tools:

```bash
pnpm install
task install
```

This links `~/.local/bin/diffdesk` and `~/.local/bin/ghl` to the built app; add that directory to PATH.

## Use

```bash
diffdesk                    # review the current branch, including uncommitted work
diffdesk feature            # review another revision without checking it out
diffdesk --base main        # choose the comparison base
diffdesk --repo ../other    # review another checkout
diffdesk comments           # print this comparison's comments, compact for an agent
diffdesk comments --json    # the same, as JSON
```

`diffdesk` opens the review in the Diffdesk window and returns to the terminal; later invocations replace it in the same window. `diffdesk comments` and `diffdesk --version` print without opening it. Comments and Viewed live in each checkout's `.git/ghl/state.json`. Run `diffdesk --help` for every option.

- Unified or split diffs, file tree, full-diff search and expandable context.
- Branch, base and commit pickers, with `gh stack` navigation.
- Persistent comments per branch, code anchors, a comments side panel and a compact copy for agents.
- Viewed files, working-tree/untracked controls and whitespace filtering.
- Image previews, native menus, and light and dark appearance with a syntax theme for each.

See the [reviewing guide](https://diffdesk.vmaerten.fr/guide/reviewing/) for comparisons, comments and state. Features on `main` may be newer than the published release; see the [changelog](./CHANGELOG.md).

## Shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `v` | Toggle Viewed |
| `c` | Comment selected lines |
| `b` / `t` | Pick a base / target revision |
| `l` | Pick a commit |
| `s` | Pick a stack layer |
| `[` / `]` | Review the stack layer below / above |
| `r` | Refresh |
| `Cmd+K` | Command palette |
| `Cmd+P` | Go to a file |
| `Cmd+f` | Search the diff |
| `Cmd` + hover / click | Symbol info / go to definition (beta, in Settings) |
| `Cmd+[` | Back from a definition |
| `Cmd+1` / `Cmd+2` | Unified / split diff |
| `Cmd+O` / `Cmd+W` | Open a repository / close the review |
| `Shift+Cmd+C` | Copy all comments |
| `Cmd+,` | Settings |

## Development

After `pnpm install`:

```bash
task dev           # the UI in a browser with hot reload, against a Go dev server
task desktop:run   # build and open the app (arguments after --)
task test          # Go, API and UI tests
task check         # types, lint, formatting and Go vet
task site:dev      # the website and guide, with hot reload
```

See the [app guide](./desktop/README.md) for the window and its native tests, and the [server guide](./go/README.md) for the review API, state and the development loop.

## Documentation

- [The website](https://diffdesk.vmaerten.fr/) and its guide: [getting started](https://diffdesk.vmaerten.fr/guide/getting-started/), [installation](https://diffdesk.vmaerten.fr/guide/installation/), [reviewing code](https://diffdesk.vmaerten.fr/guide/reviewing/) and [keyboard shortcuts](https://diffdesk.vmaerten.fr/guide/shortcuts/), written in [`site/`](./site/src/content/docs/guide/)
- [The app](./desktop/README.md) and [its review server](./go/README.md)
- [Releases](./docs/releases.md) and [release acceptance](./docs/validation.md)
