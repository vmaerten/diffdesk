# Changelog

## Unreleased

### ✨ Features

- Clean up after the browser CLI when the app starts: stop the daemon ghl 0.1 or 0.2 left on port 7777, remove its lock folder, and remove a CLI installed from source in `~/.local/bin/ghl` that would shadow the app's `ghl`. ([#180](https://github.com/vmaerten/ghl/pull/180))
- Highlight code in background workers, so scrolling a large review no longer stutters as each file comes into view, and render it about twice as fast. Reviews of thousands of files and checkouts with many branches load faster too. ([#192](https://github.com/vmaerten/ghl/pull/192))
- Open the window maximised: it fills the screen with the menu bar and the Dock still visible, and the zoom button brings it back to its former size. ([#200](https://github.com/vmaerten/ghl/pull/200))
- Centre the comparison capsule in the title bar; in a narrow window it moves left to keep room for the actions. ([#201](https://github.com/vmaerten/ghl/pull/201))
- Show a stacked branch's layer, such as `2/3`, at the start of the comparison in the title bar instead of a line of branches in the status bar: it opens the stack from the top layer down to the trunk, with each pull request and whether a layer is merged or pruned. Press `s` to open it, and `[` or `]` to review the layer below or above. ([#202](https://github.com/vmaerten/ghl/pull/202))
- Open a review in place of the one shown instead of in a new tab: running `ghl` in another checkout, or opening a repository with `Cmd+O`, replaces it. ([#203](https://github.com/vmaerten/ghl/pull/203))
- Right-click a file in the tree or on its header for a native menu with Viewed, Copy Path and Reveal in Finder on that file. ([#208](https://github.com/vmaerten/ghl/pull/208))
- Offer a compact title bar, 38 px instead of 52 with macOS's compact toolbar, to give the code more room: Settings, under Window, turns it on from the next launch. ([#210](https://github.com/vmaerten/ghl/pull/210))
- Resolve a comment instead of deleting it: Resolve on a card closes it and keeps it, out of the diff, the panel, the count and Copy. `ghl comments` and Copy show each comment's ID, `ghl comments --all` lists resolved comments too, and `ghl comments resolve <id>` and `reopen <id>` work from the terminal. The review state moves to version 2; an older ghl refuses it instead of reopening resolved comments.

### 🐛 Fixes

- Stop a base picked in the window from emptying a branch's reviews for good: the base is now dimmed text in the title bar, so a click meant for the reviewed branch no longer opens the base picker, the pickers open on the current choice so Enter alone changes nothing, and a picked base holds for the review shown instead of being written to `.git/config`. **Automatic base** drops it, and a review whose base already contains the whole branch says so and offers the automatic base. Bases that earlier releases remembered in `branch.<name>.ghlBase` are ignored. ([#218](https://github.com/vmaerten/ghl/pull/218))
- Read the review whatever diff prefixes Git is configured with (`diff.mnemonicPrefix`, `diff.noprefix`, `diff.srcPrefix`), instead of losing Viewed, comments and context on every file; with `diff.suppressBlankEmpty`, comments after a blank line now anchor on the right code. ([#184](https://github.com/vmaerten/ghl/pull/184))
- Open the window when ghl is launched from the Finder, Spotlight or the Dock, instead of failing with "Could not open repository"; error dialogs show the message rather than the server's JSON, and a `ghl` run while the app quits opens in a new window instead of being lost. ([#185](https://github.com/vmaerten/ghl/pull/185))
- Keep reviews and `ghl comments` working after a crash left the state lock behind, and in reftable repositories: only writes lock the state now, with a lock the system releases when a process dies. Reading a corrupt state no longer moves it aside; the next comment or Viewed change does. ([#186](https://github.com/vmaerten/ghl/pull/186))
- Keep the review's keys and position right when the comparison changes: an open comment whose line leaves the diff no longer blocks the single-letter shortcuts, `j`, `k` and `v` follow the file you scrolled to, search no longer jumps back to a match when you tick Viewed, context still expands after a failed refresh, and a Viewed tick survives switching tabs while it saves. The target picker is labelled as such, and the comments panel lists files in the tree's order. ([#187](https://github.com/vmaerten/ghl/pull/187))
- Refuse review writes that are not JSON, so a web page served on another localhost port can no longer add or delete comments, change Viewed or change the remembered base. ([#188](https://github.com/vmaerten/ghl/pull/188))
- Review and export comments during a merge, rebase, cherry-pick or revert, with a warning naming the conflicted files; a stopped rebase keeps the branch's comments. Untracked symlinks, special files and files over 20 MB are left out with a notice instead of failing the review, comments on non-UTF-8 lines no longer turn stale, file names with a backslash can be commented on, and image previews work in folders whose name holds `#`, `?` or `%`. ([#189](https://github.com/vmaerten/ghl/pull/189))
- Expand context and keep comments fresh on files with a textconv driver or a CRLF checkout (`eol=crlf`, `core.autocrlf`), instead of asking for a refresh every time. Files are shown as Git stores them, without textconv, and files other filters such as Git LFS rewrite say context is unavailable. ([#190](https://github.com/vmaerten/ghl/pull/190))
- Keep a file's header opaque to its corners while it stays at the top of a scrolled review, instead of letting the code show through its rounded top left. ([#199](https://github.com/vmaerten/ghl/pull/199))

### 📦 Distribution

- Build with Go 1.27.3, which fixes standard library vulnerabilities in `net/http`, `crypto/x509` and `os`. `brew uninstall --cask --zap ghl` also removes the app's caches and web data, and the installation guide covers downloading the zip from the release page. Releases run one at a time and never move the cask back to an older version. ([#191](https://github.com/vmaerten/ghl/pull/191))
- Run the app on Wails v3 (v3.0.0-beta.34) instead of Wails v2: with two reviews open it uses 16 to 46 MiB less memory, and switching reviews is slightly faster. ([#207](https://github.com/vmaerten/ghl/pull/207))

## 0.3.1

### 🐛 Fixes

- Open the review when `ghl` runs with another or no `TMPDIR`, as in some tool environments, instead of failing with "the ghl app did not start". ([#178](https://github.com/vmaerten/ghl/pull/178))

## 0.3.0

ghl is now a macOS app. `ghl` opens or activates a review tab in one native window instead of serving the review to a browser. Comments and Viewed stay in the same `.git/ghl/state.json`, and settings saved by the earlier `ghl Desktop` build are read until the first change.

### 💥 Breaking changes

- Replace the browser CLI, its shared daemon on port 7777 and the `ghl.localhost` URLs with the app's own window. `ghl comments [--json]` and `ghl --version [--json]` still print in the terminal; `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` and `GHL_PORT` are removed. ([#167](https://github.com/vmaerten/ghl/pull/167), [#169](https://github.com/vmaerten/ghl/pull/169), [#171](https://github.com/vmaerten/ghl/pull/171))
- Ship one archive, `ghl_<version>_darwin_arm64.zip` with `ghl.app`, for macOS 13 or later on Apple Silicon. Linux and macOS Intel stay on 0.2.0. ([#172](https://github.com/vmaerten/ghl/pull/172))

### ✨ Features

- Review in a macOS-style window: review tabs in a unified title bar holding the comparison controls, a translucent file sidebar, files as cards, a comments side panel beside the diff, a status bar and native menus. ([#155](https://github.com/vmaerten/ghl/pull/155)–[#164](https://github.com/vmaerten/ghl/pull/164))
- Choose the appearance (System, Light or Dark), a syntax theme for each mode and the code font and size in Settings. ([#157](https://github.com/vmaerten/ghl/pull/157))

### 🐛 Fixes

- Open every review requested while the app is still starting, once each; a launch that cannot reach the app now fails with an error instead of returning silently. ([#136](https://github.com/vmaerten/ghl/issues/136))

### 📦 Distribution

- Install with Homebrew, `brew install --cask vmaerten/tap/ghl`, or keep mise's `github:vmaerten/ghl`, which moves to the app on upgrade. ([#173](https://github.com/vmaerten/ghl/pull/173))

## 0.2.0

### ✨ Features

- Add an **Ignore whitespace** control that filters whitespace-only changes and updates file and line counts. Preserve the choice in the URL, keep separate Viewed ticks for each mode, and retain comments on hidden files in the panel. ([#147](https://github.com/vmaerten/ghl/pull/147))
- Open the default Linux browser through `xdg-open`. ([#143](https://github.com/vmaerten/ghl/pull/143))

### 🐛 Fixes

- Keep comments on their original branch across branch switches and restarts, including in the comments panel, pending saves and CLI exports. ([#148](https://github.com/vmaerten/ghl/pull/148))
- Use the fetched remote trunk when the local trunk is strictly behind it, avoiding unrelated upstream changes in the review. Keep local branches that are ahead or diverged, without fetching or changing the checkout. ([#83](https://github.com/vmaerten/ghl/pull/83))
- Keep rapid Viewed toggles and resets in order, prevent refreshes from restoring older state, and roll back failed saves without replacing newer actions. ([80110a1](https://github.com/vmaerten/ghl/commit/80110a185f796adf4d652420af50689447716f43))
- Preserve a comment's first saved code anchor, creation time and original comparison when retrying a save, including after code changes. ([933b847](https://github.com/vmaerten/ghl/commit/933b847b8452c7ead0d4bce553c27e5d3a293031))
- Wrap review controls on narrow mobile screens so the whitespace control does not cause horizontal overflow. ([bdd7f75](https://github.com/vmaerten/ghl/commit/bdd7f7505543ca8b56255c3288628fd9e40d22ac))

### 📦 Distribution

- Add release build targets for macOS Intel, Linux ARM64 and Linux x86-64. ([#144](https://github.com/vmaerten/ghl/pull/144))
- Validate every archive's checksum, layout and Go OS/architecture settings; exercise platform-specific CLI, browser and mise installation gates locally.

### 📚 Documentation

- Shorten the README and move detailed usage into a dedicated reviewing guide. ([#150](https://github.com/vmaerten/ghl/pull/150))

## 0.1.0

The `ghl` backend and CLI now run exclusively on Go. React is embedded in the executable; users need only Git and a browser. The initial release target is macOS Apple Silicon (ARM64), distributed through GitHub Releases and mise.

### 💥 Breaking changes

- Remove the Node backend, CLI and fallback installer. Node and pnpm are only needed for development, frontend builds and test drivers.

### ✨ Features

- Preserve existing comments, anchors, timestamps and Viewed state directly in each checkout's version-1 `.git/ghl/state.json`, with a shared transaction lock.
- Review unified or split text diffs, expand unchanged context on demand, and preview image changes side by side with click-to-zoom.
- Pick a local base or target branch, review a single commit against its first parent, and control working-tree and untracked changes from the page. Keep comparison choices in the URL so later CLI invocations do not override them.
- Follow `gh stack` layers, including metadata in linked worktrees, and fall back past merged or deleted layers. Use the trunk for branches with no commits of their own, while retaining guessed and remembered bases.
- Keep the virtualized tree and diff in the same file order. Fold Viewed files in place, reveal them from the tree, and clear their ticks when their changes move. Render edited files renamed across languages and search the entire diff, including files outside the mounted viewport.
- Write, edit and delete line comments with original code anchors and per-line stale markers. Browse comments outside the current diff in the comments panel, collapse inline cards, and copy individual comments or the full review with code. Export Markdown or JSON through `ghl comments`, with code available as soon as a comment is saved.
- Add file-name copy buttons, popular dark and light editor themes, keyboard shortcuts and a responsive review layout with a full-width mobile comments panel.
- Reuse a shared local daemon and stable `ghl.localhost:7777` repository URLs; newer Go executables replace it while preserving registered repositories.

### 🐛 Fixes

- Fix search input replacement during delayed opening frames and skip nested untracked Git repositories/worktrees rather than aborting the entire review.

### 🔧 Internal

- Use native Task, Air and Vite for build, installation and hot reload.

Stop an old Node daemon before starting Go on the same port. Read the [migration guide](https://github.com/vmaerten/ghl/blob/v0.1.0/docs/migration.md) for PATH precedence, backups and rollback, and the [installation guide](https://github.com/vmaerten/ghl/blob/v0.1.0/docs/go-installation.md) for mise commands. Other platforms and the optional URL without a port remain follow-up work.
