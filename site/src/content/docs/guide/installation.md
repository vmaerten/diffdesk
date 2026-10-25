---
title: Installation
description: Install ghl with Homebrew or mise, then pin, upgrade, roll back or uninstall it.
---

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
brew uninstall --cask --zap ghl      # also remove its settings, caches and web data
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

## From the release page

A browser download of `ghl_<version>_darwin_arm64.zip` is quarantined, and Gatekeeper refuses to open the ad hoc signed app. Compare `shasum -a 256 ghl_<version>_darwin_arm64.zip` with the release's `checksums.txt`, unzip it, then remove the attribute before the first launch:

```bash
xattr -dr com.apple.quarantine ghl.app
```

Move `ghl.app` to `/Applications` and link `ghl.app/Contents/MacOS/ghl` into a folder on PATH. Homebrew and mise do all of this for you.

## After installing, upgrading or rolling back

A running window keeps the version it started with: quit ghl (`Cmd+Q`) to use the new one. Comments and Viewed stay in each checkout's `.git/ghl/state.json` across upgrades, rollbacks and uninstalls. A release that resolves comments writes it as version 2 at the first change, which earlier releases refuse rather than reopen resolved comments: rolling back past it requires moving that file aside. Settings live in `~/Library/Application Support/ghl/settings.json`.

## Moving from the 0.2.0 browser CLI

- `mise upgrade` or `mise use -g github:vmaerten/ghl@latest` moves from the CLI to the app: same tool, new archive. Linux and macOS Intel are not served after 0.2.0; stay on `github:vmaerten/ghl@0.2.0` there.
- When it starts, the app stops a 0.1 or 0.2 daemon still running on port 7777 and removes its lock folder. Open its reviews in the app with `ghl` in each checkout.
- Comments and Viewed carry over unchanged: the app uses the same `.git/ghl/state.json`.
- `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` and `GHL_PORT` are gone.
- A CLI installed from source by the 0.1 or 0.2 `task install`, a copy in `~/.local/bin/ghl`, or the earlier Node copy in `~/.local/share/ghl` with its link, is removed when the app starts; `task install` also replaces that copy. Any other file named `~/.local/bin/ghl` stays, and `task install` refuses to replace it.
- Settings saved by the earlier `ghl Desktop` app are read until the first change, then saved under `ghl`.
