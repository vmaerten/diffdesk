# Go runtime

This module contains the default production entry point
and the isolated review PoC. Both use the same backend; their UI assets, command
identities and state directories remain separate.

The Go runtime supports text review including optional untracked files, context
expansion, image previews, comments, Viewed, automatic bases, stacks and revision/commit selection.
The CLI supports revision targets, summaries, comment exports and a shared
background daemon. Go is the only supported backend and CLI runtime; see the
[migration guide](../docs/migration.md) for legacy Node installations.

## Build and run

From the repository root, with pnpm dependencies installed, Go >= 1.24 and
[Task v3](https://taskfile.dev/installation/):

```bash
task build
./go/dist/ghl --version
./go/dist/ghl --version --json
./go/dist/ghl --repo /path/to/repository --base main
./go/dist/ghl feature --base main --print
./go/dist/ghl comments --base main
./go/dist/ghl comments feature --base main --json
task test
task vet
```

The output is one executable with the production Vite build embedded. Git and
a browser are its runtime prerequisites. Node, pnpm, Go and Task are only required
to build; the module has no external Go dependencies. Go race tests also need
a C toolchain, and browser tests need Chrome.

By default the command starts or reuses one detached Go daemon, registers the
repository and returns. The daemon listens only on `127.0.0.1:7777`. Defaults
are the current repository and automatic base resolution. `--port` overrides
`GHL_PORT`; `--port 0` starts a separate daemon on an ephemeral port, without
sharing or a stable port. A chosen nonzero port is exact: collisions fail with
an explanation and never silently move to another port.

The opening URL prefers `http://ghl.localhost:7777/r/<repoId>` when the system
resolves that hostname to IPv4 `127.0.0.1`, otherwise it uses `127.0.0.1`. The
fallback retains the same port and repository ID. Chrome is tested with both
the advertised URL and `ghl.localhost`, including the secure-context clipboard.
There is no hosts-file change, proxy, certificate or port-free setup.

`--no-open` skips the browser. Automatic opening uses `open` on macOS and
`xdg-open` on Linux; a missing URL handler is reported on stderr. `--json` prints
one `{port, repoId, url}` announcement. `--no-daemon` stays in the foreground
and stops cleanly with Ctrl-C. `task dev` uses that foreground mode on a
separate development backend port (5181 by default), so hot reload does not
touch the shared daemon.
`--idle <minutes>` configures a newly started daemon (default 30, fractional
minutes allowed, 0 disables shutdown); reusing a daemon keeps its existing idle
setting. Accepted requests reset the idle clock. A visible React tab sends a
heartbeat every five minutes, keeping the default daemon alive. Rejected Host/Origin requests do not reset the idle clock.

## Shared runtime lifecycle

A daemon registers canonical repository roots. Subdirectories and symlink
aliases join the same entry; linked worktrees get their own IDs and state.
Comparison choices stay in each opening URL. Stable repository URLs survive
another repository joining and a successful binary upgrade on the same port.
The registry is in memory: after an idle stop or explicit shutdown, run `ghl`
in each repository to register it again. Comments and Viewed remain on disk.

Launchers use a per-user, per-port kernel lock in a private temporary directory
to serialize startup and upgrades across unrelated repositories. A readiness
pipe announces the actual listening port, including ephemeral mode. The child
starts a separate session with no terminal stdin; the CLI can exit without
stopping it. Locks release when a launcher exits, including on a crash.

Discovery checks the Go marker, runtime, protocol version, daemon mode, binary
revision and instance identity. The binary revision is SHA-256 of the executable,
including its embedded assets. A different binary with a compatible protocol
replaces the previous Go daemon and restores its registered repositories.
Shutdown requires the probed instance ID, so a delayed request cannot stop a
replacement. Registration freezes before the shutdown response captures the
handoff list. Missing repositories produce restore notices rather than silently
being reported as registered. If replacement startup fails, rerun `ghl` in the
repositories to register them; review state stays on disk.

Node, the isolated PoC, foreground servers, incompatible protocols and unrelated
listeners are never reused or stopped. For coexistence, choose another port:

```bash
./go/dist/ghl --port 7778 --no-open
./go/dist/ghl --no-daemon --port 0 --no-open
```

`GET /api/health` exposes identity and registered paths. `GET /api/repos` lists
entries; `POST /api/repos` accepts an absolute `repoPath`, validates it with Git
and canonicalizes it. `POST /api/heartbeat` records activity. To stop your Go
daemon, read its current health and send `POST /api/shutdown` with the JSON
body `{ "instance": "<instance from health>" }`. Requests stay on loopback with
Host/Origin allowlists; CLI control requests bypass proxies and reject redirects.

`test/goDaemon.ts`, included in `task test`, drives relocated binaries with only
Git in PATH. It covers cold start, reuse, multiple repos/worktrees, terminal exit,
simultaneous starts/upgrades, handoff/bookmarks, stale shutdowns, idle/heartbeat,
ephemeral ports, environment overrides, incompatible listeners, legacy protocol
rejection, and Chrome hostname/clipboard checks. Go race tests cover concurrent
registration, conditional shutdown, rejected requests and lock cancellation.

## CLI and exports

`ghl [target] [options]` reviews a branch or revision without checking it out.
Omitting the target includes the checkout's staged and unstaged changes.
Options can appear before or after the target. An explicit `--base` or target
travels in the opening URL, so the UI can clear it and return to its default.
`ghl comments` reserves that first word as a command; review a branch named
`comments` with `ghl refs/heads/comments`.

`--print` writes the repository, reviewed target, resolved base and its source,
patch counts, excluded untracked count and optional stack chain. It exits
without loading assets, binding a port or opening a browser. Comments exports
have the same independent behavior; `comments` takes precedence over `--print`.
An ongoing merge, rebase or cherry-pick is still rejected by the comparison
backend, including for these commands, rather than exported as a complete review.

`ghl comments [target]` exports Markdown, with `--json` selecting the existing
`{repo, range, comments}` contract. Only comments on files in the comparison are
included, regardless of their saved range. Checkout exports include untracked
files automatically; revision exports exclude checkout edits and untracked files.
Lines come from the selected side, including context outside displayed hunks
and previous paths on renamed files. JSON adds `was` only for stale anchors.
Markdown explains changed or unavailable code and retains original lines.
The React panel can additionally copy comments on files outside the comparison.

Go and React use a shared set of export goldens. Path/line order is stable
and independent of the machine's locale (UTF-16 path order, then starting line);
ties retain input order.

Help (`-h` / `--help`), version, summaries and exports go to stdout and return 0
on success. Errors return 1 with a `ghl:` diagnostic on stderr. A recovered
corrupt-state notice goes to stderr without contaminating JSON. Short commands
never print startup announcements; plain server startup prints the repository,
base and URL, while `--json` prints one `{port, repoId, url}` announcement.
Help and version work without Git, a checkout or a frontend build.

`test/goCLI.ts`, included in `task test`, checks actual Go command output
across checkout and revision scopes, base sources, renamed/context/stale/missing
code and untracked comments. It checks argument failures, stderr separation,
short commands with an occupied port, and a relocated binary with only Git in
PATH. Go tests also exercise asset-free commands and shared export goldens.

## State compatibility and transition

Production Go reads and writes Node's version-1 `.git/ghl/state.json` directly.
Reading an existing file does not rewrite it. Comment IDs, timestamps, anchors,
range keys and Viewed hashes remain compatible, including nullable binary hashes.
Older states with omitted version/empty collections are normalized as version 1.
An unsupported version fails without modifying or quarantining the file.

The path is relative to the checkout's Git directory. A linked worktree has its
own state and lock, rather than sharing those of the main checkout. The PoC keeps
`.git/ghl-go-poc/state.json`. Earlier production prototypes' `.git/ghl-go/state.json`
also stay untouched; neither file is imported automatically.

The production review's `w=1` URL option uses Git `--ignore-all-space` for its patch
and statistics. Filtered Viewed entries use a range key suffixed with `?w=1`, leaving
the full diff's ticks independent and preserving the version-1 storage format.
Comment provenance keeps the ordinary range. Context expansion reads both original
source versions, and comment anchors use the selected side's actual whitespace.

To merge an existing prototype snapshot, first stop writers of that source and
run from the repository (or supply `--repo`):

```bash
./go/dist/ghl --import-state "$(git rev-parse --git-path ghl-go/state.json)"
# Explicitly opt in to PoC data, with a machine-readable report:
./go/dist/ghl --import-state "$(git rev-parse --git-path ghl-go-poc/state.json)" --json
```

This is an independent CLI operation that needs no commit, frontend, server or
browser. It merges comments by ID and Viewed entries by range/path. Identical
records are skipped, so repeated imports are idempotent. Different records with
the same ID or different hashes for the same Viewed entry abort the entire merge.
Both files remain unchanged on conflict. The source is always retained, and an
existing destination is copied byte-for-byte to `state-import-*.backup` before
writing a successful merge. The report gives the backup path and added counts.
Resolve a conflict in a separate copy of the source rather than editing live state.

Production Go reads/mutations hold a worktree-private Git lock
through the complete disk transaction. This covers multiple foreground servers,
CLI exports and imports. It uses a prepared
[`git update-ref --stdin` transaction](https://git-scm.com/docs/git-update-ref),
aborted on stdin closure; no ref is committed and reference hooks are disabled.
Waiting is bounded to 10 seconds, with cancellation in Go requests. A parent
process crash closes the pipe and releases the lock. Git must support the
`start`/`prepare` transaction commands.

Writes use a unique neighboring temporary file, sync it, then rename it over
state. A process interruption preserves either the previous or new complete file;
unfinished temporary files are ignored. Corrupt files move to unique `.corrupt`
backups and produce a UI notice or CLI stderr diagnostic. Permission and other
I/O errors fail instead of being treated as empty state.

Stop legacy Node daemons before switching; older installations do not use the
common lock and cannot safely write concurrently. Node is no longer shipped.
To undo an import, stop writers and restore the reported backup over `state.json`
(or remove the destination if it did not exist beforehand). Source snapshots remain.

`test/goState.ts`, included in `task test`, seeds the version-1 schema and tests
concurrent writers across independent Go servers. It checks add/edit/delete/Viewed
preservation, both anchor sides, original timestamps, restart, imports/conflicts,
linked worktrees, corrupt-state recovery and future-schema refusal. Go race tests
also cover independent stores, cancelled waits and a killed Go writer with an
interrupted temporary file.

Release builds include macOS ARM64/Intel and Linux ARM64/x86-64. Filesystem
reads, Git transaction locks and daemon startup use the same Unix implementation.
Windows is not a supported build target. See the [platform validation guide](../docs/validation.md#platform-validation)
for native and translated execution coverage; cross-compilation alone does not
establish native hardware support.

## Review selection

The production command resolves the base in this order:
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

`task test` checks Go payloads, context and anchors against Git across these scopes,
then runs the image browser checks against Go.
The shared UI suites in `test/run.ts` drive the built desktop UI against Go in headless Chrome,
with the Wails bindings simulated by `desktop/simulator.ts`. Each suite gets its own fixture and
browser context, and several run at once: half the cores, at most 8; `GHL_TEST_JOBS` overrides it.
The isolated PoC keeps its explicit-base checkout scope and hidden pickers.

The **Untracked** checkbox includes files returned by Git's ignore-aware listing;
it defaults to off and keeps its count visible. Its state is the presence of
`untracked` in the URL. Ref, commit and committed-only views exclude checkout
untracked files even when that flag is present. The PoC still rejects this flag.

Included regular files get Git patches, counts, hashes and comment anchors.
Executable bits and `.gitattributes` are preserved, without changing the index.
Before diffing, reads refuse symlinks and special files and enforce the same
20 MiB limit as context. Non-image binaries remain listed without context or a preview.
The default listing does not open untracked files, so a large file or symlink
does not block an ordinary tracked review. Opting in fails explicitly on an
unsafe, oversized or disappeared text source rather than silently omitting it.

Untracked comments follow the same Viewed and stale-line rules as tracked files.
Excluding or deleting a file leaves its comments and original anchors in the
panel and in React's Markdown copy. Go contract tests also verify Markdown
and JSON export data for included, stale and unavailable untracked code;
command-line exports consume the same comparison support.

## Image previews

PNG, JPEG, GIF, WebP, AVIF, SVG, ICO and BMP previews use the existing React
before/after view and enlargement overlay. Their URLs identify the exact
comparison revisions and preserve previous paths for renames. The browser
decodes images and displays dimensions and sizes; Go serves the original bytes
with their content type. Committed metadata uses Git object IDs without loading
blob bytes, while worktree identity hashes a bounded snapshot. Image hashes
replace patch hashes for Viewed, invalidating the tick when image bytes change.

`GET /r/<repoId>/api/image` accepts `revision=worktree` or a full 40/64-character
Git object ID and a canonical repository-relative image path. Reads share the
context reader's regular-file checks and 20 MiB bound. Symlinks, special files,
malformed paths, non-image paths and oversized sources are refused. Responses
use `no-store`, `nosniff` and a sandboxed CSP that keeps SVG scripts and external
resources inactive even when opened directly.

Unavailable previews retain their file and an explanation. In particular,
unsafe or oversized untracked images remain in the tree without asking Git to
read their bytes: their file count is retained, with no patch or text line counts
invented for that source. Tests check image patches, metadata, hashes and exact
bytes against fixture contents. Invalid image data reports a decoding failure in
React. The isolated PoC still has no image route or metadata.

## Development

Install Node >= 24, pnpm, Go >= 1.24, Git and [Task v3](https://taskfile.dev/installation/),
then run from the checkout:

```bash
pnpm install
task dev
# Review another checkout, with an explicit base:
task dev REPO=/path/to/repository BASE=main
# Choose both ports and leave browser opening to you:
task dev PORT=5182 BACKEND_PORT=5183 OPEN=false
# Or run each service in its own terminal:
task dev:go
task dev:web
```

`task dev` installs the pinned Air watcher in `.task/bin` on its first run.
That download needs network access; subsequent runs reuse it. Air is a
development tool only and adds no dependency to the runtime Go module.

Task starts Air and the Vite CLI in parallel, without a TypeScript launcher.
Vite serves the desktop UI on `127.0.0.1:5180`, on the Wails bindings simulated by
`desktop/simulator.ts`, with Fast Refresh and CSS hot reload,
proxying API requests to Go on `127.0.0.1:5181`. `BACKEND_PORT` chooses another
fixed backend port; `PORT=0` chooses a free frontend port instead of 5180.
Vite waits up to 30 seconds for the backend, then opens the review unless
`OPEN=false`. An occupied port fails explicitly and stops the other service.
Use the same `REPO`, `BASE` and `BACKEND_PORT` settings in both terminals when
running `dev:go` and `dev:web` separately.

Go changes trigger a rebuild and restart behind Vite's API proxy; the browser
URL stays the same through those restarts. Air reports compilation errors and
restarts the last successful build until valid code is saved. Ctrl-C stops
Vite, Air and the backend. The native development tasks also use `curl` and
`lsof`, supplied with macOS.

The development command compiles `cmd/ghl-dev`, which uses the live frontend;
there is no embedded asset build in this loop. It uses the same backend and
`.git/ghl/state.json` as the production Go command. The initial review
defaults to the directory where Task was invoked and resolves its base automatically.
The default `pnpm dev` uses the Go workflow above.

The Taskfile defines the production build, `go test -race` and `go vet`
commands directly. `task test` also runs the contract/browser harness;
`task check` runs the static checks. `task test:dev` checks React/CSS
refresh, Go restart, persisted review state, compile-error recovery, port
conflicts and shutdown in an isolated temporary checkout. It needs Chrome.
`task --list` lists these tasks and the isolated PoC build/test commands.

## Release artifacts

`mise install --locked` installs the build tools pinned in the repository. From
its root, `mise exec -- task release:snapshot` creates and verifies a macOS ARM64
archive with the executable, MIT license and third-party notices. A version-tag
publication uses the exact locally validated files on GitHub Releases. See the
[release guide](../docs/releases.md) for tag checks, metadata, credentials and
local builds. Consumer installation through mise remains tracked separately.
The [acceptance guide](../docs/validation.md) describes the local release gate,
archive-based contract/browser/lifecycle suites and production runtime measurements.

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
revision identifier, process ID and repository list. Both health endpoints report
`ghlGo: true`; only the PoC reports `ghlGoPoc: true`. Production health also
reports `daemon` and a random `instance` ID. Go does not advertise Node's
`ghl: true` marker, so the Node CLI cannot mistake it for a Node daemon.
