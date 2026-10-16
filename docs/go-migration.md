# Migrate from Node to Go

Go is the only supported backend and CLI runtime. React is embedded in one
executable; only Git and a browser are required at runtime. The first release supports macOS
Apple Silicon. Windows, Linux and macOS Intel remain separate validation work.
The Node backend, CLI, install scripts and reference tests have been removed.
Node and pnpm remain build tools for React and the TypeScript test drivers.

## Existing installation

Close review tabs and stop the old Node daemon before launching Go on the same
port. Go reports a conflicting listener instead of replacing an unknown runtime.
The Node shutdown route accepts a POST from the local machine:

```bash
curl --noproxy '*' --fail -X POST http://127.0.0.1:7777/api/shutdown
```

Use the port you previously selected. If no daemon is running, skip that command.
Stopping the process does not delete review state. For a backup, copy each
checkout's `.git/ghl/state.json` while writers are stopped. In a linked worktree,
locate it with `git rev-parse --git-path ghl/state.json`.

Install the published release following the [mise guide](./go-installation.md),
then check which executable your shell selects:

```bash
mise use -g github:vmaerten/ghl@0.1.0
type -a ghl
mise which ghl
ghl --version --json
```

Version JSON must report `runtime: "go"`. If `~/.local/bin/ghl` from the old
source installation wins, remove that old link after selecting the mise version,
or invoke the selected executable explicitly with `mise exec -- ghl`.
Do not remove repository state or the old Node runtime directory for this switch.

Launch from the same checkout. Its repository ID, default hostname/port and
bookmarked URL stay the same. Go reads the existing version-1 state directly:
comments, anchors, creation timestamps and Viewed ticks require no import.
The isolated PoC state is not automatically imported. See
[state compatibility](../go/README.md#state-compatibility-and-transition) for explicit imports.

## Build and install from source

Until a release archive is available, or when testing a checkout, install the
build tools pinned by `.mise.toml`, then run:

```bash
mise install
pnpm install --frozen-lockfile
task install
~/.local/bin/ghl --version --json
```

`task install` builds and atomically replaces `~/.local/bin/ghl`, including an
older Node symlink, without following or deleting its target. It does not stop
an old Node daemon: stop that process first as above. Set `BIN_DIR` to select
another directory, for example `task install BIN_DIR=/path/to/bin`.
`pnpm install:local` invokes this same Task workflow.

`task run -- --base main --print` builds and runs Go from the checkout. Build
output goes to stderr so CLI JSON/Markdown on stdout remains usable.
`task dev` and `pnpm dev` start Vite + Air with hot reload.

## Upgrades and rollback

For Go-to-Go upgrades or downgrade through mise, the next launch replaces a
daemon with a different executable identity and retains registered repositories.
Version selection alone does not restart it. A historical release-to-release
upgrade will be validated when a second compatible release exists; the first
release's acceptance uses a synthetic predecessor for replacement coverage.

## Remove a source installation

`task uninstall` removes only the local Go command and preserves repository
review state. Legacy Node installations are no longer managed by this checkout;
after stopping the old daemon, remove their old command link and copied runtime
from the installation paths you selected (previous defaults were
`~/.local/bin/ghl-node` and `~/.local/share/ghl`). Preserve `.git/ghl/state.json`.

Stop a running daemon first, or close tabs and let its idle timeout stop it.
To remove a mise installation, follow the mise guide instead.

The standard URL remains `http://ghl.localhost:7777/r/<repoId>`. Setup for an URL
without a port is deferred; it is not required for installation or review.
