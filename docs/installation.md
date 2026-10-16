# Install ghl with mise

Release builds cover macOS Apple Silicon (`darwin_arm64`), macOS Intel
(`darwin_amd64`), Linux ARM64 (`linux_arm64`) and Linux x86-64 (`linux_amd64`).
Choose a published version that contains the matching archive: v0.1.0 ships only
macOS ARM64, and the additional targets first become available in a later release
after platform acceptance. Git and a browser are runtime prerequisites. React is
embedded; consumers do not need Node, pnpm or Go. On Linux, automatic browser
opening uses `xdg-open` (usually supplied by `xdg-utils`); `--no-open` prints the URL
without invoking a desktop handler.

Go is the default runtime. Release installation requires an archive in
[GitHub Releases](https://github.com/vmaerten/ghl/releases); source installation is
covered in the [migration guide](./migration.md). Private releases require
GitHub authentication with read access; see
[mise's tokens guide](https://mise.jdx.dev/dev-tools/github-tokens.html).

## Install and put ghl on PATH

Install [mise](https://mise.jdx.dev/installing-mise.html). If `mise` itself is on
PATH, add this once to `~/.zshrc`:

```bash
eval "$(mise activate zsh)"
```

Open a new terminal, replace `X.Y.Z` with a published version containing your
platform archive, and install globally:

```bash
mise use -g github:vmaerten/ghl@X.Y.Z
ghl --version
cd /path/to/repository
ghl
```

The built-in backend selects `ghl_<version>_<os>_<arch>.tar.gz`, verifies its
digest from GitHub or `checksums.txt`, extracts it and exposes `ghl`. No plugin
is needed; a short `mise use ghl` registry name is not registered.

`mise use` installs/selects a version; shell activation updates PATH. Without
activation, run `mise exec -- ghl` to use the configured version. An explicit
one-off alternative is `mise exec github:vmaerten/ghl@latest -- ghl --version`.
[Shims](https://mise.jdx.dev/dev-tools/shims.html) are another option for scripts
and IDEs: `mise activate zsh --shims` exposes the generated shims.

Project configuration can override the global selection. Check `mise which ghl`
and `type -a ghl` if an older Node installation wins in PATH. Current mise defaults
delay `latest` by 24 hours after publication; an exact version bypasses this
delay. After that delay, `mise use -g github:vmaerten/ghl@latest` follows stable
releases. `latest` excludes prereleases. Use `mise ls-remote github:vmaerten/ghl`
to list published versions.

## Pin, upgrade and roll back

Replace `X.Y.Z` with a published version, without the tag's `v` prefix:

```bash
mise use -g github:vmaerten/ghl@X.Y.Z
mise exec -- ghl --version
```

An exact selection stays pinned during `mise upgrade`. To follow stable releases,
select `latest` again. For an existing `latest` selection, retain the old install
when upgrading:

```bash
mise upgrade --no-prune github:vmaerten/ghl
ghl --version
ghl
```

Run outside projects that override the tool. `--no-prune` matters: mise may
otherwise remove the old installation. Roll back with
`mise use -g github:vmaerten/ghl@X.Y.Z`, then launch `ghl` again.

Installing/selecting a version does not restart a running daemon. `ghl --version`
reports the selected executable; the next normal launch replaces a Go daemon
with a different executable identity. On the same port it retains registered
repositories and bookmark URLs. Comments, anchors, timestamps and Viewed stay
in each checkout's version-1 `.git/ghl/state.json`. Rollback requires releases
that can read that schema; consult release notes before future schema changes.

The default URL is `http://ghl.localhost:7777/r/<repoId>`, with a `127.0.0.1`
fallback. `--port` overrides the port. Stop an older Node daemon on 7777 first or
use another port; Go never silently replaces it. See the
[runtime lifecycle](../go/README.md#shared-runtime-lifecycle).

## Uninstall

```bash
mise unuse -g --no-prune github:vmaerten/ghl
mise uninstall --all github:vmaerten/ghl
```

Remove any project selection too. Repository comments and Viewed are preserved.
A running daemon continues until its idle timeout or explicit shutdown. Close
review tabs to allow the normal 30-minute idle stop, or follow the immediate
shutdown procedure in the runtime lifecycle guide before uninstalling.

## Maintainer verification

Use mise **2026.10.2**, selecting a binary for the architecture being tested
(`GHL_TEST_MISE` can select it explicitly). Node is a test driver; the
installed executable runs with only Git in PATH. All mise configuration, data,
cache and state live in temporary directories outside the checkout. Tests do
not change your mise configuration or install a global `ghl`.

```bash
task release:snapshot
task release:mise

# Other target platforms: install/startup check without the upgrade suite
task release:smoke

# Once releases exist; PREVIOUS is optional:
task release:mise:published VERSION=X.Y.Z
task release:mise:published VERSION=X.Y.Z PREVIOUS=A.B.C
```

`GHL_TEST_MISE=/absolute/path/to/mise` selects a separate test installation.
`GITHUB_TOKEN` or `GH_TOKEN` can authenticate private release reads, without write
access. Published mode downloads actual GitHub assets and compares the installed
executable with the checksummed archive. Run it locally after manual publication.
It does not delete or replace the release. Rerun after diagnosing a failure.

Before publication, `release:mise` routes the real mise GitHub client to a
loopback API with the supported URL replacement setting. It serves the candidate
and a synthetic predecessor with different bytes and the same build metadata.
It checks autodetection, checksum fallback, corrupt downloads, activation/shims,
exact pins, actual `mise upgrade`, rollback, daemon replacement, embedded assets,
state preservation and uninstall. It creates no tag or GitHub release. This is
fixture coverage, not evidence of a published download or historical upgrade.
`release:smoke` reuses the same fixture for one install and startup check; it skips
upgrade/rollback and corruption scenarios. Run the full suite on the primary
platform and smoke checks on the other targets.

Target-suffixed reports such as `.task/go-mise-acceptance-linux_arm64.json` and
`.task/go-mise-published-darwin_amd64.json` are local validation artifacts. Native
host runs also retain the existing unsuffixed report names for compatibility. They start with `complete: false`; only a finished run sets it to true.
`scope` distinguishes `full` acceptance from `smoke` checks.
`upgrade` records whether two versions were exercised and `latest` whether stable
resolution was checked. The first release has no historical upgrade to test;
that remains pending until a second compatible version exists. Prereleases are
tested with exact pins, without claiming that default `latest` selected them.

References: [GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html),
[release age](https://mise.jdx.dev/configuration/settings.html#minimum_release_age),
[URL replacements](https://mise.jdx.dev/url-replacements.html).
