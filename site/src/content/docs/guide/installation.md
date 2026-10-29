---
title: Installation
description: Install Diffdesk with Homebrew or mise, then pin, upgrade, roll back or uninstall it.
---

Diffdesk is a macOS app for Apple Silicon (ARM64), from macOS 13. Git is its only runtime prerequisite. Each release on [GitHub Releases](https://github.com/vmaerten/diffdesk/releases) publishes `diffdesk_<version>_darwin_arm64.zip`, which holds `Diffdesk.app`, the MIT license and third-party notices, with its SHA-256 in `checksums.txt`. Homebrew and mise both install that archive and put `diffdesk`, the app's executable, on PATH.

The app was called ghl until 0.4; see [moving from ghl](#moving-from-ghl-to-diffdesk). Releases up to 0.2.0 shipped a browser CLI instead; see [moving from 0.2.0](#moving-from-the-020-browser-cli).

## Homebrew

```bash
brew install --cask vmaerten/tap/diffdesk
diffdesk --version
```

The cask installs `Diffdesk.app` in `/Applications` and links `diffdesk` into Homebrew's `bin`, with `ghl`, the command's former name. Name it in full: Homebrew 7 loads casks from a third-party tap only once trusted, and installing by full name trusts this one. After `brew tap vmaerten/tap`, a bare `brew install --cask diffdesk` first needs `brew trust --cask vmaerten/tap/diffdesk`.

The app is signed ad hoc, without Apple notarisation. Homebrew quarantines what it downloads, and Gatekeeper would then block the first launch; the cask removes that quarantine attribute after installing.

```bash
brew upgrade --cask diffdesk              # follow stable releases
brew uninstall --cask diffdesk            # remove the app, keep its settings
brew uninstall --cask --zap diffdesk      # also remove its settings, caches and web data
```

## mise

Install [mise](https://mise.jdx.dev/installing-mise.html). If `mise` itself is on PATH, add this once to `~/.zshrc`:

```bash
eval "$(mise activate zsh)"
```

Open a new terminal and install globally:

```bash
mise use -g github:vmaerten/diffdesk@latest
diffdesk --version
```

The built-in GitHub backend selects `diffdesk_<version>_darwin_arm64.zip`, verifies its digest from GitHub or `checksums.txt`, extracts it and puts `Diffdesk.app/Contents/MacOS` on PATH. No plugin or option is needed. mise downloads without the quarantine attribute, so the app opens without a Gatekeeper prompt. The app stays in mise's install directory rather than `/Applications`, so it is opened with `diffdesk`, not from Spotlight or the Dock. mise puts only `diffdesk` on PATH, not `ghl`.

`mise use` installs and selects a version; shell activation updates PATH. Without activation, `mise exec -- diffdesk` runs the configured version. [Shims](https://mise.jdx.dev/dev-tools/shims.html) are another option for scripts and IDEs: `mise activate zsh --shims` exposes them. Project configuration can override the global selection; check `mise which diffdesk` and `type -a diffdesk` if another `diffdesk` wins in PATH. Current mise defaults delay `latest` by 24 hours after publication; an exact version bypasses that delay, and `latest` excludes prereleases. `mise ls-remote github:vmaerten/diffdesk` lists published versions.

### Pin, upgrade and roll back

Replace `X.Y.Z` with a published version, without the tag's `v` prefix:

```bash
mise use -g github:vmaerten/diffdesk@X.Y.Z
mise upgrade --no-prune github:vmaerten/diffdesk
```

An exact selection stays pinned during `mise upgrade`; select `latest` again to follow stable releases. `--no-prune` keeps the previous install, so rolling back is another `mise use -g github:vmaerten/diffdesk@X.Y.Z`.

### Uninstall

```bash
mise unuse -g --no-prune github:vmaerten/diffdesk
mise uninstall --all github:vmaerten/diffdesk
```

Remove any project selection too.

## From the release page

A browser download of `diffdesk_<version>_darwin_arm64.zip` is quarantined, and Gatekeeper refuses to open the ad hoc signed app. Compare `shasum -a 256 diffdesk_<version>_darwin_arm64.zip` with the release's `checksums.txt`, unzip it, then remove the attribute before the first launch:

```bash
xattr -dr com.apple.quarantine Diffdesk.app
```

Move `Diffdesk.app` to `/Applications` and link `Diffdesk.app/Contents/MacOS/diffdesk` into a folder on PATH. Homebrew and mise do all of this for you.

## After installing, upgrading or rolling back

Stable builds installed through Homebrew or mise check for a newer stable release when the app starts. A banner at the bottom of the window offers **Later** to keep working, or **Update…**. Expand **What’s new in…** to read the proposed release’s changelog before deciding; if it has no notes, a link opens its GitHub release page. Confirm **Update and Restart** to install through the same manager and reopen the active comparison. You can also use **Diffdesk → Check for Updates…**. The banner shows installation progress and any failure, with **Try Again** when available. Its state and release notes stay available after reloading the review. Save any comment drafts before confirming: restarting discards unsaved drafts and other open tabs.

For mise installs, accepting an update selects `latest` in the global configuration and retains the previous install. Project version pins keep priority when launching from those projects. For Homebrew installs, the cask can briefly lag behind GitHub Releases; if the offered version is not installed yet, Diffdesk keeps running and asks you to retry later. A failed startup check stays silent; manual checks and installation failures report the error. Source builds, prereleases and manually downloaded copies do not offer automatic installation.

After upgrading or rolling back from the terminal, a running window keeps the version it started with: quit Diffdesk (`Cmd+Q`) to use the new one. Comments and Viewed stay in each checkout's `.git/ghl/state.json` across upgrades, rollbacks and uninstalls. A release that resolves comments writes it as version 2 at the first change, which earlier releases refuse rather than reopen resolved comments: rolling back past it requires moving that file aside. Settings live in `~/Library/Application Support/Diffdesk/settings.json`.

## Moving from ghl to Diffdesk

Homebrew trusts a cask by name, so trust the new one before upgrading, or `brew upgrade` skips it:

```bash
brew update
brew trust --cask vmaerten/tap/diffdesk
brew upgrade --cask diffdesk
rm -rf "$(brew --caskroom)/ghl"
```

- The upgrade replaces `ghl.app` with `Diffdesk.app`, and links `ghl` beside `diffdesk`. It leaves an empty `ghl` entry that `brew list` shows and `brew doctor` reports; the last line removes it.
- With mise, `github:vmaerten/ghl` keeps upgrading through GitHub's redirect to the renamed repository; after `mise upgrade`, the command is `diffdesk`. To move to the new name:

  ```bash
  mise use -g github:vmaerten/diffdesk@latest
  mise unuse -g --no-prune github:vmaerten/ghl
  mise uninstall --all github:vmaerten/ghl
  ```

- Comments and Viewed stay in each checkout's `.git/ghl/state.json`. Settings are read from `~/Library/Application Support/ghl` until the first change, then saved under `Diffdesk`. The sidebar and panel widths start over once.
- A ghl window still open keeps running until you quit it.

## Moving from the 0.2.0 browser CLI

- `mise upgrade`, or `mise use -g github:vmaerten/diffdesk@latest` under the repository's new name, moves from the CLI to the app. Linux and macOS Intel are not served after 0.2.0; stay on `github:vmaerten/diffdesk@0.2.0` there.
- When it starts, the app stops a 0.1 or 0.2 daemon still running on port 7777 and removes its lock folder. Open its reviews in the app with `diffdesk` in each checkout.
- Comments and Viewed carry over unchanged: the app uses the same `.git/ghl/state.json`.
- `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` and `GHL_PORT` are gone.
- A CLI installed from source by the 0.1 or 0.2 `task install`, a copy in `~/.local/bin/ghl`, or the earlier Node copy in `~/.local/share/ghl` with its link, is removed when the app starts; `task install` also replaces that copy. Any other file named `~/.local/bin/ghl` stays, and `task install` refuses to replace it.
- Settings saved by the earlier `ghl Desktop` app are read until the first change, then saved under `Diffdesk`.
