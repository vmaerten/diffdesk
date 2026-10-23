# Install ghl

ghl is a macOS app for Apple Silicon (ARM64), from macOS 13. Git is its only runtime prerequisite. Each release on [GitHub Releases](https://github.com/vmaerten/ghl/releases) publishes `ghl_<version>_darwin_arm64.zip`, which holds `ghl.app`, the MIT license and third-party notices, with its SHA-256 in `checksums.txt`. Homebrew and mise both install that archive and put `ghl`, the app's executable, on PATH.

Releases up to 0.2.0 shipped a browser CLI instead; see [moving from 0.2.0](#moving-from-the-020-browser-cli).

## Homebrew

```bash
brew install --cask vmaerten/tap/ghl
ghl --version
```

The cask installs `ghl.app` in `/Applications` and links `ghl` into Homebrew's `bin`. Name it in full: Homebrew 7 loads casks from a third-party tap only once trusted, and installing by full name trusts this one. After `brew tap vmaerten/tap`, a bare `brew install --cask ghl` first needs `brew trust --cask vmaerten/tap/ghl`.

The app is signed ad hoc, without Apple notarisation. Homebrew quarantines what it downloads, and Gatekeeper would then block the first launch; the cask removes that quarantine attribute after installing.

```bash
brew upgrade --cask ghl              # follow stable releases
brew uninstall --cask ghl            # remove the app, keep its settings
brew uninstall --cask --zap ghl      # also remove its settings
```

## mise

Install [mise](https://mise.jdx.dev/installing-mise.html). If `mise` itself is on PATH, add this once to `~/.zshrc`:

```bash
eval "$(mise activate zsh)"
```

Open a new terminal and install globally:

```bash
mise use -g github:vmaerten/ghl@latest
ghl --version
```

The built-in GitHub backend selects `ghl_<version>_darwin_arm64.zip`, verifies its digest from GitHub or `checksums.txt`, extracts it and puts `ghl.app/Contents/MacOS` on PATH. No plugin or option is needed. mise downloads without the quarantine attribute, so the app opens without a Gatekeeper prompt. The app stays in mise's install directory rather than `/Applications`, so it is opened with `ghl`, not from Spotlight or the Dock.

`mise use` installs and selects a version; shell activation updates PATH. Without activation, `mise exec -- ghl` runs the configured version. [Shims](https://mise.jdx.dev/dev-tools/shims.html) are another option for scripts and IDEs: `mise activate zsh --shims` exposes them. Project configuration can override the global selection; check `mise which ghl` and `type -a ghl` if another `ghl` wins in PATH. Current mise defaults delay `latest` by 24 hours after publication; an exact version bypasses that delay, and `latest` excludes prereleases. `mise ls-remote github:vmaerten/ghl` lists published versions.

### Pin, upgrade and roll back

Replace `X.Y.Z` with a published version, without the tag's `v` prefix:

```bash
mise use -g github:vmaerten/ghl@X.Y.Z
mise upgrade --no-prune github:vmaerten/ghl
```

An exact selection stays pinned during `mise upgrade`; select `latest` again to follow stable releases. `--no-prune` keeps the previous install, so rolling back is another `mise use -g github:vmaerten/ghl@X.Y.Z`.

### Uninstall

```bash
mise unuse -g --no-prune github:vmaerten/ghl
mise uninstall --all github:vmaerten/ghl
```

Remove any project selection too.

## After installing, upgrading or rolling back

A running window keeps the version it started with: quit ghl (`Cmd+Q`) to use the new one. Comments and Viewed stay in each checkout's version-1 `.git/ghl/state.json` across upgrades, rollbacks and uninstalls; rollback requires releases that read that schema. Settings live in `~/Library/Application Support/ghl/settings.json`.

## Moving from the 0.2.0 browser CLI

- `mise upgrade` or `mise use -g github:vmaerten/ghl@latest` moves from the CLI to the app: same tool, new archive. Linux and macOS Intel are not served after 0.2.0; stay on `github:vmaerten/ghl@0.2.0` there.
- A 0.2.0 daemon still running on port 7777 stops on its own after 30 minutes without an open tab. Open its reviews in the app with `ghl` in each checkout.
- Comments and Viewed carry over unchanged: the app uses the same `.git/ghl/state.json`.
- `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` and `GHL_PORT` are gone.
- A CLI installed from source with `task install` is a plain file in `~/.local/bin/ghl`, which `task install` now refuses to replace: remove it once.
- Settings saved by the earlier `ghl Desktop` app are read until the first change, then saved under `ghl`.

## Maintainer verification

Use mise **2026.10.2**; `GHL_TEST_MISE` can point at that binary. All mise configuration, data, cache and state live in temporary directories outside the checkout: the tests change neither your mise configuration nor a global `ghl`.

```bash
task release:snapshot
task release:mise

# Once releases exist; PREVIOUS is optional:
task release:mise:published VERSION=X.Y.Z
task release:mise:published VERSION=X.Y.Z PREVIOUS=A.B.C
```

Before publication, `release:mise` routes the real mise GitHub client to a loopback API with mise's URL replacement setting. It serves the candidate archive, a predecessor (the candidate with another bundle marker, signed again), a prerelease and a corrupt download. It checks autodetection, the checksum fallback, activation and shims, `ghl --version` and `ghl comments` with only Git on PATH, the absence of quarantine and a valid signature, the window opened from the mise install, exact pins, `mise upgrade`, rollback, the corrupt download and uninstall. It creates no tag or release; it is fixture coverage, not evidence of a published download.

Published mode downloads the actual GitHub assets, compares the installed executable with the checksummed archive, and upgrades from `PREVIOUS` when given; that version may be a 0.2.0-era CLI tarball. `GITHUB_TOKEN` or `GH_TOKEN` can authenticate the reads, without write access. The tests set `GHL_PORT=0`, so an old CLI can never start or replace a daemon on your own port. Reports land in `.task/mise-acceptance.json` and `.task/mise-published.json`, starting with `complete: false`.

References: [GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html), [release age](https://mise.jdx.dev/configuration/settings.html#minimum_release_age), [URL replacements](https://mise.jdx.dev/url-replacements.html).
