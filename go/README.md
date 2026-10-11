# Go runtime

This module contains the production entry point being introduced in [#98](https://github.com/vmaerten/ghl/issues/98)
and the isolated review PoC. Both use the same backend; their UI assets, command
identities and state directories remain separate.

The Go runtime supports tracked text review, context expansion, comments,
Viewed, automatic bases, stacks and revision/commit selection. Untracked files,
image previews, the full CLI, exports and the shared daemon are still being
ported. The Node command remains the default until that work is validated.

## Build and run

From the repository root, with pnpm dependencies installed, Go >= 1.24 and
[Task v3](https://taskfile.dev/installation/):

```bash
task build
./go/dist/ghl --version
./go/dist/ghl --version --json
./go/dist/ghl --repo /path/to/repository --base main
task test
task vet
```

The output is one executable with the production Vite build embedded. Git and
a browser are its runtime prerequisites. Node, pnpm, Go and Task are only required
to build; the module has no external Go dependencies. Go race tests also need
a C toolchain, and browser tests need Chrome.

The current command runs in the foreground, listens only on `127.0.0.1` and
stops cleanly with Ctrl-C. Its defaults are the current repository, automatic
base resolution and an ephemeral port. `--port`, `--no-open` and the startup announcement
`--json` are available; automatic browser opening currently targets macOS.
The stable hostname/port and shared daemon are tracked in #104.

The interim production entry point stores review state in
`.git/ghl-go/state.json`, relative to each checkout's git-dir. It does not
read or change Node's `.git/ghl/state.json` or PoC data. This is temporary:
#103 owns compatibility, migration and prevention of concurrent data loss
before the default runtime changes. Do not run concurrent writers against
the same Go state file yet.

The initial validated platform is macOS ARM64. Unix context-read flags are
retained from the PoC; Windows is not a supported build target at this stage.

## Review selection

The production command resolves the base with the same precedence as Node:
an explicit URL choice, a remembered `branch.<name>.ghlBase`, gh-stack metadata,
the nearest parent heuristic, then the detected trunk. The trunk wins equal
parent scores. Stack metadata is read from the worktree's Git directory, with
the common directory as a compatibility fallback; missing or merged layers
remain visible while the next layer uses the nearest live base below.

The React base, target and commit pickers and `b` / `t` / `l` shortcuts are
available in the Go build. Base choices are remembered against the reviewed
branch. The URL controls each comparison: removing an explicit base re-enables
resolution, even when the command was started with `--base`.

`target` reviews a revision without checking it out. `committed` excludes staged
and unstaged work from a checkout review. `commit` shows the selected commit's
own diff against its first parent, or the empty tree for a root commit; its
Viewed state uses that parent/commit pair. An unavailable commit falls back to
the whole range with a notice. Invalid bases or targets fail explicitly.

`task test` checks Node/Go payloads, context and anchors across these scopes,
then runs the existing picker, commit and stack browser suites against Go.
The isolated PoC keeps its explicit-base checkout scope and hidden pickers.

## Development

Install Node >= 24, pnpm, Go >= 1.24, Git and [Task v3](https://taskfile.dev/installation/),
then run from the checkout:

```bash
pnpm install
task dev
# Review another checkout, with an explicit base:
task dev REPO=/path/to/repository BASE=main
# Choose the frontend port and leave browser opening to you:
task dev PORT=5181 OPEN=false
```

`task dev` installs the pinned Air watcher in `.task/bin` on its first run.
That download needs network access; subsequent runs reuse it. Air is a
development tool only and adds no dependency to the runtime Go module.

Vite serves React on `127.0.0.1:5180` with Fast Refresh and CSS hot reload.
Go changes trigger a rebuild and restart behind Vite's API proxy, using a
separate ephemeral backend port. The printed browser URL stays the same
through those restarts. Air reports compilation errors and restarts the last
successful build until valid code is saved. Ctrl-C stops Vite, Air and the backend.
`PORT=0` chooses a free frontend port instead of 5180.

The development command compiles `cmd/ghl-dev`, which uses the live frontend;
there is no embedded asset build in this loop. It uses the same backend and
`.git/ghl-go/state.json` as the production Go command. The initial review
defaults to the directory where Task was invoked and resolves its base automatically.
The Node workflow (`pnpm dev`, proxying to port 7777) remains available.

The Taskfile defines the production build, `go test -race` and `go vet`
commands directly. `task test` also runs the contract/browser harness;
`task check` runs the static checks. `task test:dev` checks React/CSS
refresh, Go restart, persisted review state, compile-error recovery, port
conflicts and shutdown in an isolated temporary checkout. It needs Chrome.
`task --list` lists these tasks and the isolated PoC build/test commands.

## Layout and build identity

```text
cmd/ghl/          production command and generated embedded UI
cmd/ghl-dev/      development command behind Vite and Air
cmd/ghl-go-poc/   isolated PoC command and generated embedded UI
internal/app/    comparison, state, HTTP server and shared command lifecycle
```

`task poc:build` produces `poc/go/dist/ghl-go-poc`, and
`task poc:test` runs the same contract/browser harness against that command.
The pnpm commands `go:build`, `go:test`, `go:vet`, `poc:go:build` and
`poc:go:test` remain aliases for the Taskfile tasks.
Only placeholders are tracked under the asset directories. Vite builds the
selected frontend before Go compiles its entry point. A direct `go build`
without a frontend build can print its version/help, but refuses to start a
server without `index.html`.

The build task defaults to the package version, current Git commit (with
`-dirty` for tracked changes) and the current UTC build time. Release tooling
can override `GHL_BUILD_VERSION`, `GHL_BUILD_COMMIT` and `SOURCE_DATE_EPOCH`.
Direct Go builds use `dev` / `unknown` metadata.

`--version --json` and `/api/health` expose matching `version`, `commit`,
`buildDate`, `runtime` and `protocolVersion` fields. Health also contains a
revision identifier, process ID and repository list. Both commands report
`ghlGo: true`; only the PoC reports `ghlGoPoc: true`. The incomplete Go server
does not advertise Node's `ghl: true` daemon marker, so the existing CLI cannot
mistake it for a compatible shared Node instance.
