# ghl

Review the PR you are about to open, without opening it.

A local Git diff viewer with a GitHub-like interface. Review branches, commits
and working-tree changes in your browser, then copy your comments to an agent.
Go executable, embedded React UI. Only Git and a browser are needed to run it.

## Install

With [mise](https://mise.jdx.dev/):

```bash
mise use -g github:vmaerten/ghl@0.2.0
cd /path/to/repository
ghl
```

Release archives cover macOS (Apple Silicon and Intel) and Linux (ARM64 and
x86-64). See the [installation guide](./docs/installation.md) for PATH setup,
upgrades and rollback.

To install from source, with Node >= 24, pnpm, Go >= 1.24 and Task v3 installed:

```bash
pnpm install
task install
```

This installs `ghl` in `~/.local/bin`; add that directory to PATH.

## Use

```bash
ghl                    # review the current branch, including uncommitted work
ghl feature            # review another revision without checking it out
ghl --base main        # choose the comparison base
ghl --print            # print a summary without opening a browser
ghl comments           # export comments with code as Markdown
ghl comments --json    # export structured comments
```

The browser opens a stable `http://ghl.localhost:7777/r/<repoId>` URL. One
background process serves your repositories; closing the terminal keeps the
review open. Comments and Viewed state live in each checkout's Git directory.
Run `ghl --help` for other options.

- Unified or split diffs, file tree, full-diff search and expandable context.
- Branch, base and commit pickers, with `gh stack` navigation.
- Persistent comments per branch, code anchors, a comments panel and Markdown copy.
- Viewed files, working-tree/untracked controls and whitespace filtering.
- Image previews with zoom, dark/light themes and a mobile layout.

See the [reviewing guide](./docs/reviewing.md) for comparisons, comments and state.
Features on `main` may be newer than the published release; see the [changelog](./CHANGELOG.md).

## Shortcuts

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous file |
| `v` | Toggle Viewed |
| `c` | Comment selected lines |
| `b` / `t` | Pick a base / target revision |
| `l` | Pick a commit |
| `r` | Refresh |
| `Ctrl+f` / `Cmd+f` | Search the diff |

## Development

After `pnpm install`:

```bash
task dev      # React hot reload and Go restart
task build    # build go/dist/ghl with the UI embedded
task check    # types, lint, formatting and Go vet
task test     # Go, CLI, API and browser tests
```

See the [development guide](./go/README.md#development) for prerequisites,
ports and reviewing another checkout.

## Documentation

- [Reviewing code](./docs/reviewing.md)
- [Installation](./docs/installation.md) and [migration from Node](./docs/migration.md)
- [Runtime, state and CLI](./go/README.md)
- [Releases](./docs/releases.md) and [validation](./docs/validation.md)
- [Go proof of concept](./docs/go-poc.md)
