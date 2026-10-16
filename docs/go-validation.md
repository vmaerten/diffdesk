# Go release acceptance

Release builds target **macOS ARM64/Intel and Linux ARM64/x86-64**. GitHub Actions is disabled;
there are no automatic CI checks or hosted release jobs. Maintainers run the
locked toolchain and Chrome for Testing 154.0.8037.92 locally, with static checks,
Go race tests, hot reload, installation tests, archive
validation, production Go acceptance and three-pass runtime measurements.

## Local gate

From the checkout, with the locked tools installed:

```bash
mise install --locked
pnpm install --frozen-lockfile
task test:browser:install
task check
task test:go
task test:dev
task test:install
task test
task release:check
task release:snapshot
task release:acceptance
task release:mise
task release:bench
```

The browser installer downloads into the ignored `.task/browser/` directory.
The harness prefers this exact build; `CHROME_PATH` can explicitly choose a
different executable. The harness automatically selects the installed pinned browser.
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
there is no previous published Go release to install yet. Node-to-Go state
compatibility and restart are tested separately against seeded version-1 fixtures.

## Promotion policy

The [mise distribution checks](./go-installation.md#maintainer-verification)
exercise the real client/backend with a local release API before publication
and actual GitHub assets afterward. The local published check verifies installed
bytes, PATH, standalone serving and saved state, then upgrades/rolls back when a
previous compatible release exists. The real published-download gate passed for v0.1.0 on macOS ARM64. Other
platforms need their own first published-download gate; historical upgrades
require a previous published release with an archive for that same target.

Run all relevant local checks before publishing. These checks are not enforced
by a GitHub workflow; publication is manual using the verified archive.
Measurements check response correctness and record performance; they impose no
RAM or latency threshold. Go is the only supported application runtime.

## Platform validation

Build all four archives with `task release:snapshot`. `release:verify` checks
all four checksums, archive layouts, licenses and Go build settings, then runs
the selected archive. `release:acceptance` drives that archive through the CLI,
state, daemon, API and browser suites. `release:mise` verifies asset selection
among four platform filenames, activation, shims, checksums and saved state.

```bash
# Native macOS host archive:
task release:acceptance
GHL_TEST_MISE=/path/to/mise-2026.10.2 task release:mise

# macOS Intel, using Rosetta when the host is Apple Silicon:
task platform:macos-intel

# Debian Linux containers, using the local Docker engine:
task platform:linux ARCH=arm64
task platform:linux ARCH=amd64
```

Docker is a maintainer test prerequisite only. The image pins Node and verifies
Go/mise downloads against checksums. Git and Chromium are installed in an
isolated container, running as an unprivileged user. The input checkout and Git
metadata are read-only; a temporary clone receives the tests. Containers are
removed after the run, while logs and an initially incomplete validation report
stay in `.task/platform-linux/<arch>/`. The final report records the kernel,
engine/target architectures, Go/Node/browser versions and completed gates. macOS
Intel logs and mise results stay in `.task/platform-macos-intel/`.

CPU translation is reported explicitly. On an Apple Silicon Docker host, Linux
ARM64 runs on its native CPU architecture in a Linux VM, Linux x86-64 uses
translation, and macOS Intel uses Rosetta. These runs establish executable
coverage on the corresponding OS; they do not establish native Intel/x86-64
hardware coverage or performance. Native hardware acceptance remains required
before closing the platform issues or advertising that stronger guarantee:

- [macOS Intel #121](https://github.com/vmaerten/ghl/issues/121)
- [Linux #122](https://github.com/vmaerten/ghl/issues/122)
- [Windows #123](https://github.com/vmaerten/ghl/issues/123), still outside the build matrix

Run every applicable gate before publishing that target. A failed or incomplete
platform gate is not a publication approval. No additional hosted CI is enabled.
The existing performance benchmark remains macOS ARM64-specific.

See [production runtime measurements](./go-runtime-benchmark.md) for the
fixtures, results and limits of the performance comparison. Earlier minimal
prototype and isolated PoC reports remain separate.
