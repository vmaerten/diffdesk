# Release acceptance

Release builds target **macOS ARM64/Intel and Linux ARM64/x86-64**. GitHub Actions is disabled;
there are no automatic CI checks or hosted release jobs. Maintainers run the
locked toolchain and Chrome for Testing 154.0.8037.92 locally. Run the full
Go and archive acceptance suites once on the primary platform, macOS ARM64;
other targets receive the smoke checks below.

## Local gate

From the checkout, with the locked tools installed:

```bash
mise install --locked
pnpm install --frozen-lockfile
task test:browser:install
task check
task test:go
task release:check
task release:snapshot
task release:acceptance
task release:mise
```

The browser installer downloads into the ignored `.task/browser/` directory.
The harness prefers this exact build; `CHROME_PATH` can explicitly choose a
different executable. The harness automatically selects the installed pinned browser.
Chrome, Python and the C toolchain used by `-race` are test prerequisites;
they are excluded from the consumer's release archive.

For a checked-out version tag, substitute `RELEASE_TAG=vX.Y.Z task release:build`
for the snapshot step. See [releases](./releases.md) for tag validation.
Run `task test:dev` or `task test:install` when changing those workflows. Use
`task release:bench` for runtime/performance changes, after browser tests finish.
The archive acceptance suite already covers the CLI, API and browser; running
`task test` as well would repeat them.

## Checks against the archive

`release:acceptance` first checks the archive's checksum, exact file list,
regular-file entries, licenses and build identity. It extracts the executable
outside the checkout and passes that path to the production suites; it does not
rebuild the binary. An outdated archive fails the commit/version checks.

| Suite            | Behavior exercised                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goCLI.ts`       | Go summaries and Markdown/JSON exports, scopes, errors, stdout/stderr and relocated executable                                                                               |
| `goState.ts`     | Existing version-1 state, concurrent Go writers, original anchors/timestamps, Viewed, restart, worktrees, imports, corruption and schema rollback                            |
| `goDaemon.ts`    | Shared repositories, concurrent starts, instance replacement, bookmark stability, preserved comments/Viewed, idle/heartbeat/shutdown, Host/Origin and actual clipboard reads |
| `goPoc.ts go`    | Production diff/context/mutation contracts, renamed/Unicode/untracked files, stale/outside comments and browser review actions                                               |
| `goRevisions.ts` | Automatic and remembered bases, stacks, refs, targets, root/merge/selected commits, fallback and commit anchors                                                              |
| `goImages.ts`    | Go image metadata and bytes, unsafe/oversized sources, browser previews and unavailable-image behavior                                                                       |
| `run.ts`         | All fifteen shared browser suites: themes, review panel, tree, resize, Viewed, comments, pickers, scroll, renames, order, stacks, commits, worktree, untracked and search    |

The relocated CLI, standalone HTTP checks, daemon tests and shared Go browser
harness run the executable with a PATH containing only Git. The Node test
driver and Chrome remain separate processes. `--version` is also exercised
with an empty PATH. Clipboard checks grant browser permissions and read the
real clipboard on loopback and `ghl.localhost`; the older UI suites retain
their Markdown transport simulations.

The daemon upgrade test changes executable identity by appending a payload to
a copy of the candidate. It checks a new process/revision, transferred repository
registrations and unchanged comment/Viewed data. This simulates replacement;
the separate published mise check exercises actual upgrades and rollback when a
compatible earlier release exists. Node-to-Go state compatibility and restart
are tested separately against seeded version-1 fixtures.

## Promotion policy

The [mise distribution checks](./installation.md#maintainer-verification)
exercise the real client/backend with a local release API before publication
and actual GitHub assets afterward. The local published check verifies installed
bytes, PATH, standalone serving and saved state, then upgrades/rolls back when a
previous compatible release exists. The real published-download gate passed for v0.1.0 on macOS ARM64. Other
platforms need their own first published-download gate; historical upgrades
require a previous published release with an archive for that same target.
For v0.2.0, use `PREVIOUS=0.1.0` on macOS ARM64; the other targets have no
published predecessor.

Run all relevant local checks before publishing. These checks are not enforced
by a GitHub workflow; publication is manual using the verified archive.
Measurements check response correctness and record performance; they impose no
RAM or latency threshold. Go is the only supported application runtime.

## Platform validation

Build all four archives with `task release:snapshot`. `release:verify` checks
all four checksums, archive layouts, licenses and Go build settings. Run the
full `release:acceptance` and `release:mise` suites once on macOS ARM64.

For each additional target, copy the built archives and metadata into the same
checkout on that OS/architecture and run:

```bash
task release:smoke
```

This uses the existing validators to check startup, version/health metadata,
embedded React assets, a diff, and a single mise installation, activation and
uninstall. It skips browser suites, upgrade/rollback and corrupt-download tests.
Node, Go, Git and mise 2026.10.2 are maintainer prerequisites; a browser, pnpm,
Python, Docker and a C toolchain are unnecessary for this smoke check.

The target defaults to the current host. To exercise the Intel archive under
Rosetta on Apple Silicon, select an Intel mise binary too:

```bash
GHL_TEST_TARGET=darwin_amd64 GHL_TEST_MISE=/path/to/intel/mise task release:smoke
```

Reports retain the target and `scope: "smoke"` so a smoke check cannot be confused
with full acceptance. Translated execution establishes executable coverage, not
native hardware or performance coverage. Re-run OS-specific tests when changing
filesystem handling, process lifecycle or browser opening on that OS. No hosted
CI or dedicated platform tool installers are added.

Platform follow-ups: [macOS Intel #121](https://github.com/vmaerten/ghl/issues/121),
[Linux #122](https://github.com/vmaerten/ghl/issues/122). [Windows #123](https://github.com/vmaerten/ghl/issues/123)
remains outside the release matrix. The existing benchmark is macOS ARM64-specific.

See [production runtime measurements](./go-runtime-benchmark.md) for the
fixtures, results and limits of the performance comparison. Earlier minimal
prototype and isolated PoC reports remain separate.
