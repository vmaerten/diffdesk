# Review server

This Go module is ghl's review server: Git comparisons, review state, the HTTP API and the UI's static files. The app runs it in process, on a private loopback port, and `cmd/ghl-dev` runs it without a window for the development loop and the tests. The module depends on the Go standard library only; the Wails dependencies stay in the `desktop` module.

It supports text review including optional untracked files, context expansion, image previews, comments, Viewed, automatic bases, stacks and revision/commit selection, and exports comments for `ghl comments`.

## Runtime and API

`app.NewRuntime(assets)` returns the server; `Open` registers a repository and `Serve` answers on a listener until its context ends, then cancels Git work and drains requests. The runtime registers canonical repository roots: subdirectories and symlink aliases join the same entry, and linked worktrees get their own IDs and state. Selections belong to URLs, so registering a checkout never changes another tab's base. The registry lives in memory; comments and Viewed live on disk.

`GET /api/health` reports `version`, `commit`, `buildDate`, the process ID and the registered repositories. `POST /api/repos` accepts an absolute `repoPath`, validates it with Git and canonicalizes it. Each repository answers under `/r/<repoId>/api/`: `diff`, `diff-files`, `comments`, `viewed`, `base`, `refs`, `commits` and `image`. Requests are accepted only for the `localhost`, `127.0.0.1` and `::1` hosts, and writes only from those origins over `http` or `https`. The app's asset handler forwards its private Wails document to this server and translates that origin only.

`ghl-dev` registers one repository and prints `{port, repoId, url}` on its first line:

```bash
task build
./go/dist/ghl-dev --repo /path/to/repository --base main --port 0
```

`--repo`, `--base` and `--port` default to `GHL_DEV_REPO`, `GHL_DEV_BASE` and `GHL_DEV_BACKEND_PORT`, which survive Air's shell runner with spaces in paths; `--port 0` picks a free port. It serves the API without any UI: Vite serves the UI in development, and the tests serve the built one.

## Comment export

`ghl comments [target]` calls `app.ExportComments`: compact text, or the `{repo, range, comments}` JSON contract with `--json`. Only comments on files in the comparison are included, whatever their saved range. Checkout exports include untracked files; revision exports exclude checkout edits and untracked files. Lines come from the selected side, including context outside displayed hunks and previous paths of renamed files. JSON adds `was` only for stale anchors. The text gives each comment its ID, `path:lines` and body, and quotes only the lines the file no longer has: `code:` for removed lines, `was:` for lines changed since or outside the comparison; `--code` quotes the current lines too. The comments panel can also copy comments on files outside the comparison.

Go and React share the text export goldens; the JSON export is written by Go alone. Order is stable and independent of the machine's locale: UTF-16 path order, then starting line, ties keeping input order. A recovered corrupt-state notice goes to stderr without touching the JSON. During a merge, rebase, cherry-pick or revert, the review and the export still show the diff, conflict markers included; the UI warns with the operation and its conflicted files.

## State

Comments and Viewed live in the version-2 `.git/ghl/state.json`. Version 2 adds each comment's status, open or resolved, to version 1, the format the earlier Node and Go releases wrote; a version-1 file is read with every comment open and written as version 2 at the next change, so a release that only knows version 1 refuses it instead of reopening resolved comments. Reading a file does not rewrite it. Comment IDs, timestamps, anchors, range keys and Viewed hashes stay compatible, including nullable binary hashes; older states with an omitted version or empty collections are read as version 1. An unsupported version fails without modifying or quarantining the file. The path is relative to the checkout's Git directory, so a linked worktree has its own state and lock.

The `w=1` option uses Git `--ignore-all-space` for the patch and statistics. Filtered Viewed entries use a range key suffixed with `?w=1`, which keeps the full diff's ticks independent within the same format. Comment provenance keeps the ordinary range. Context expansion reads both original source versions, and anchors use the selected side's actual whitespace.

Writes hold a `flock` on `state.json.lock`, beside the state, from read to rename, across processes such as the app and development servers. Waiting is bounded to 10 seconds and cancelled with the request, and the kernel releases the lock when a process dies. Reads take no lock, since every write replaces the file with a rename.

Writes go to a unique neighbouring temporary file, synced and then renamed over the state, so an interruption leaves either the previous or the new complete file. A corrupt file reads as empty state with a notice in the UI, or on stderr for `ghl comments`, and stays in place until the next write moves it to a unique `.corrupt` backup. Permission and other I/O errors fail instead of reading as empty state.

`test/goState.ts` seeds the version-1 schema and runs concurrent writers across independent servers. It checks add, edit, delete and Viewed preservation, both anchor sides, original timestamps, restarts, linked worktrees, corrupt-state recovery and future-schema refusal. Go race tests also cover independent stores, cancelled waits and a killed writer with an interrupted temporary file.

## Review selection

The base resolves in this order: an explicit URL or `--base` choice, gh-stack metadata, the nearest-parent heuristic, then the detected trunk, which wins equal parent scores. Stack metadata is read from the worktree's Git directory, with the common directory as a compatibility fallback; missing or merged layers stay visible while the next layer uses the nearest live base below. A base picked in the window is a URL choice too, never written to Git configuration; `branch.<name>.ghlBase`, which older releases wrote, is ignored. Removing the explicit base re-enables resolution.

`target` reviews a revision without checking it out. `committed` excludes staged and unstaged work from a checkout review. `commit` shows the selected commit's own diff against its first parent, or the empty tree for a root commit; its Viewed state uses that parent/commit pair. An unavailable commit falls back to the whole range with a notice. Invalid bases or targets fail explicitly.

`task test` checks payloads, context and anchors against Git across these scopes in `goRevisions.ts`. The shared UI suites in `test/run.ts` drive the built desktop UI against Go in headless Chrome, with the Wails bindings simulated by `desktop/simulator.ts`. Each suite gets its own fixture and browser context, and several run at once: half the cores, at most 8; `GHL_TEST_JOBS` overrides it.

## Image previews

PNG, JPEG, GIF, WebP, AVIF, SVG, ICO and BMP previews use the before/after view and enlargement overlay. Their URLs identify the exact comparison revisions and keep previous paths for renames. The UI decodes images and shows dimensions and sizes; Go serves the original bytes with their content type. Committed metadata uses Git object IDs without loading blob bytes, while worktree identity hashes a bounded snapshot. Image hashes replace patch hashes for Viewed, so the tick clears when the bytes change.

`GET /r/<repoId>/api/image` accepts `revision=worktree` or a full 40/64-character Git object ID and a canonical repository-relative image path. Reads share the context reader's regular-file checks and 20 MiB bound. Symlinks, special files, malformed paths, non-image paths and oversized sources are refused. Responses use `no-store`, `nosniff` and a sandboxed CSP that keeps SVG scripts and external resources inactive even when opened directly. Unavailable previews keep their file and an explanation, without inventing line counts. `goImages.ts` checks patches, metadata, hashes and exact bytes against fixture contents, and the previews in the UI.

## Development

Install Node >= 24, pnpm, Go >= 1.25, Git and [Task v3](https://taskfile.dev/installation/), then run from the checkout:

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

`task dev` installs the pinned Air watcher in `.task/bin` on its first run; that download needs network access, and later runs reuse it. Task starts Air and the Vite CLI in parallel. Vite serves the desktop UI on `127.0.0.1:5180`, on the Wails bindings simulated by `desktop/simulator.ts`, with Fast Refresh and CSS hot reload, and proxies API requests to `ghl-dev` on `127.0.0.1:5181`. `BACKEND_PORT` chooses another backend port; `PORT=0` chooses a free frontend port. Vite waits up to 30 seconds for the backend, then opens the review unless `OPEN=false`. An occupied port fails explicitly and stops the other service. Use the same `REPO`, `BASE` and `BACKEND_PORT` in both terminals when running `dev:go` and `dev:web` separately.

Go changes trigger a rebuild and restart behind Vite's proxy, and the browser URL stays the same. Air reports compilation errors and keeps the last successful build until valid code is saved. Ctrl-C stops Vite, Air and the backend. The development tasks also use `curl` and `lsof`, supplied with macOS. The initial review defaults to the directory where Task was invoked and resolves its base automatically.

`task test` runs the Go race tests and the contract and UI harness; `task check` runs the static checks. `task test:dev` checks React and CSS refresh, Go restart, persisted review state, compile-error recovery, port conflicts and shutdown in an isolated temporary checkout; it needs Chrome.

## Layout and build identity

```text
cmd/ghl-dev/     the review server without a window, behind Vite and Air and for the tests
internal/app/    comparison, state, export and HTTP server
```

`task desktop:build` stamps the package version, the current Git commit (with `-dirty` for tracked changes) and the build time into `internal/app`; release tooling sets the release version, the full commit and the commit date instead. Direct Go builds report `dev` and `unknown`. `ghl --version --json` and `/api/health` expose the same `version`, `commit` and `buildDate`.
