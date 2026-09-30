# Go runtime

This module contains the production entry point being introduced in [#98](https://github.com/vmaerten/ghl/issues/98)
and the isolated review PoC. Both use the same backend; their UI assets, command
identities and state directories remain separate.

The Go runtime currently supports tracked text review, context expansion,
comments and Viewed. Automatic base resolution, revision pickers, stacks,
untracked files, image previews, exports and the shared daemon are still being
ported. The Node command remains the default until that work is validated.

## Build and run

From the repository root, with pnpm dependencies installed and Go >= 1.24:

```bash
pnpm go:build
./go/dist/ghl --version
./go/dist/ghl --version --json
./go/dist/ghl --repo /path/to/repository --base main
pnpm go:test
pnpm go:vet
```

The output is one executable with the production Vite build embedded. Git and
a browser are its runtime prerequisites. Node, pnpm and Go are only required
to build; the module has no external Go dependencies. Go race tests also need
a C toolchain, and browser tests need Chrome.

The current command runs in the foreground, listens only on `127.0.0.1` and
stops cleanly with Ctrl-C. Its defaults are the current repository, base `HEAD`
and an ephemeral port. `--port`, `--no-open` and the startup announcement
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

## Layout and build identity

```text
cmd/ghl/          production command and generated embedded UI
cmd/ghl-go-poc/   isolated PoC command and generated embedded UI
internal/app/    comparison, state, HTTP server and shared command lifecycle
```

`pnpm poc:go:build` still produces `poc/go/dist/ghl-go-poc`, and
`pnpm poc:go:test` runs the same contract/browser harness against that command.
Only placeholders are tracked under the asset directories. Vite builds the
selected frontend before Go compiles its entry point. A direct `go build`
without a frontend build can print its version/help, but refuses to start a
server without `index.html`.

The build wrapper defaults to the package version, current Git commit (with
`-dirty` for tracked changes) and the current UTC build time. Release tooling
can override `GHL_BUILD_VERSION`, `GHL_BUILD_COMMIT` and `SOURCE_DATE_EPOCH`.
Direct Go builds use `dev` / `unknown` metadata.

`--version --json` and `/api/health` expose matching `version`, `commit`,
`buildDate`, `runtime` and `protocolVersion` fields. Health also contains a
revision identifier, process ID and repository list. Both commands report
`ghlGo: true`; only the PoC reports `ghlGoPoc: true`. The incomplete Go server
does not advertise Node's `ghl: true` daemon marker, so the existing CLI cannot
mistake it for a compatible shared Node instance.
