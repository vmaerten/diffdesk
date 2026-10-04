# Go release acceptance

The initial supported platform is **macOS ARM64**. The release workflow runs
the `Go release acceptance (macOS ARM64)` check on a native `macos-15` runner.
It installs the locked toolchain and Chrome for Testing 154.0.8037.92, then
runs static checks, Go race tests, the complete Node reference suite, archive
validation, production Go acceptance and three-pass runtime measurements.

## Local gate

From the checkout, with the locked tools installed:

```bash
mise install --locked
pnpm install --frozen-lockfile
task test:browser:install
task check
task test:go
pnpm test
task release:check
task release:snapshot
task release:acceptance
task release:bench
```

The browser installer downloads into the ignored `.task/browser/` directory.
The harness prefers this exact build; `CHROME_PATH` can explicitly choose a
different executable. CI exports the installed browser path for every suite.
Chrome, Python and the C toolchain used by `-race` are test prerequisites;
they are excluded from the consumer's release archive.

For a checked-out version tag, substitute `RELEASE_TAG=vX.Y.Z task release:build`
for the snapshot step. See [Go releases](./go-releases.md) for tag validation.
Run the measurements after the browser suites have finished.

## Checks against the archive

`release:acceptance` first checks the archive's checksum, exact file list,
regular-file entries, licenses and build identity. It extracts the executable
outside the checkout and passes that path to the production suites; it does not
rebuild the binary. An outdated archive fails the commit/version checks.

| Suite            | Behavior exercised                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goCLI.ts`       | Node/Go summaries and Markdown/JSON exports, scopes, errors, stdout/stderr and relocated executable                                                                          |
| `goState.ts`     | Existing Node state, concurrent Node/Go writers, original anchors/timestamps, Viewed, restart, worktrees, imports, corruption and schema rollback                            |
| `goDaemon.ts`    | Shared repositories, concurrent starts, instance replacement, bookmark stability, preserved comments/Viewed, idle/heartbeat/shutdown, Host/Origin and actual clipboard reads |
| `goPoc.ts go`    | Production diff/context/mutation contracts, renamed/Unicode/untracked files, stale/outside comments and browser review actions                                               |
| `goRevisions.ts` | Automatic and remembered bases, stacks, refs, targets, root/merge/selected commits, fallback and commit anchors                                                              |
| `goImages.ts`    | Node/Go image metadata and bytes, unsafe/oversized sources, browser previews and unavailable-image behavior                                                                  |
| `run.ts --go`    | All fifteen shared browser suites: themes, review panel, tree, resize, Viewed, comments, pickers, scroll, renames, order, stacks, commits, worktree, untracked and search    |

The relocated CLI, standalone HTTP checks, daemon tests and shared Go browser
harness run the executable with a PATH containing only Git. The Node test
driver and Chrome remain separate processes. `--version` is also exercised
with an empty PATH. Clipboard checks grant browser permissions and read the
real clipboard on loopback and `ghl.localhost`; the older UI suites retain
their Markdown transport simulations.

The daemon upgrade test changes executable identity by appending a payload to
a copy of the candidate. It checks a new process/revision, transferred repository
registrations and unchanged comment/Viewed data. This simulates replacement;
there is no previous published Go release to install yet. Node-to-Go state
compatibility and restart are tested separately against actual Node writers.

## Promotion policy

The publishing job depends on the complete acceptance job. A failed static,
reference, contract, browser, standalone or measurement-integrity check prevents
archive upload and publication. Measurements check response correctness and
record performance; they impose no RAM or latency threshold.

The default command remains Node until [#108](https://github.com/vmaerten/ghl/issues/108).
Its switch must be reviewed with this gate passing. GitHub currently refuses
branch protection for this private repository under its current plan, so a
required merge check cannot be enforced through repository settings. Publication
is enforced by the workflow dependency; merge enforcement remains a repository
configuration prerequisite when that feature becomes available. No repository
visibility or subscription setting was changed.

Support for other platforms must pass native acceptance before adding or
advertising their release assets:

- [macOS Intel #121](https://github.com/vmaerten/ghl/issues/121)
- [Linux #122](https://github.com/vmaerten/ghl/issues/122)
- [Windows #123](https://github.com/vmaerten/ghl/issues/123)

See [production runtime measurements](./go-runtime-benchmark.md) for the
fixtures, results and limits of the performance comparison. Earlier minimal
prototype and isolated PoC reports remain separate.
