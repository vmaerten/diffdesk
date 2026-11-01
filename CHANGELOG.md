# Changelog

## Unreleased

### ✨ Features

- Check for updates each day at 10:00 local time while Diffdesk stays open, not only at startup: a Mac asleep at 10:00 checks on wake, and a check that cannot reach GitHub is retried every 15 minutes. ([#314](https://github.com/vmaerten/diffdesk/pull/314))

## 0.10.0

### ✨ Features

- Read a Markdown file rendered: its card header switches between **Source** and **Rendered**, which shows headings, lists, GFM tables and code blocks, and marks the blocks that hold added lines. Comments stay on source lines; viewing one, or a search match, switches back to Source. ([#302](https://github.com/vmaerten/diffdesk/pull/302))
- Wrap long lines instead of scrolling each file sideways, with **View → Wrap Lines**, `Option+z` or the command palette; Settings offers the same choice under Code, and it is kept across reviews and restarts. ([#303](https://github.com/vmaerten/diffdesk/pull/303))
- Comment on a whole file, from its header, its context menu or **Review → Comment on File…**, or on the whole review, from the comments panel's `+` or **Review → Comment on Review…**. They are written and listed in the panel, review comments first, and Copy and `diffdesk comments` include them as `path (whole file)` and `(whole review)`. ([#305](https://github.com/vmaerten/diffdesk/pull/305))
- Let an agent write a walkthrough of its change for the reviewer: `diffdesk walkthrough guide` gives it the rules, `hunks` the IDs to cite, and `set` checks the tour against the comparison and saves it for the branch; `show` prints it and `clear` deletes it. A hunk that moves is found again by its content. ([#307](https://github.com/vmaerten/diffdesk/pull/307))

### 🐛 Fixes

- Close the title bar's **Options** popover with Escape, which returns the focus to its button; opening a picker or running a menu command also closes it. ([#304](https://github.com/vmaerten/diffdesk/pull/304))

### 📦 Distribution

- Point the cask, the update check and mise at the renamed `vmaerten/diffdesk` repository. Updating from the app moves a mise install made as `github:vmaerten/ghl` to `github:vmaerten/diffdesk`, and removes the old name from the global mise config while keeping its files; `mise uninstall --all github:vmaerten/ghl` deletes them. ([#267](https://github.com/vmaerten/diffdesk/pull/267))

### 🔧 Internal

- Move the Go module to `github.com/vmaerten/diffdesk` and rename the `GHL_*` development and test variables to `DIFFDESK_*`. ([#267](https://github.com/vmaerten/diffdesk/pull/267))

## 0.9.0

### ✨ Features

- Review an update in a centred sheet instead of a banner: the release notes are shown in full and scroll when long, and the sheet offers **Skip This Version**, **Remind Me Later** and **Update and Restart**, with the restart warning in place of a second confirmation. A skipped version is no longer offered at startup; a newer one or a manual check still is. The command palette (`Cmd+K`) gains **Check for Updates…**, and **Update to X and Restart…** while an update is pending. The sheet takes the focus, on the notes rather than a button, and an open comment draft keeps its text and gets the focus back. ([#286](https://github.com/vmaerten/diffdesk/pull/286))
- Install a missing language server from the app: IntelliSense and Settings offer **Install with** the first available manager (mise, Homebrew, or the language's own tool such as uv, go or rustup), a menu of the others and **Copy Command**. Installs are global and never change the reviewed project's files; a failed install keeps its output, with **Try Again**. ([#289](https://github.com/vmaerten/diffdesk/pull/289))
- Read the IntelliSense status at a glance: one row per language with its server, version and state, the context on one line with the rest under **Details**, and a banner for what blocks every language. When IntelliSense is off, **Turn On** enables it from the sheet. ([#288](https://github.com/vmaerten/diffdesk/pull/288))
- Zoom the whole interface with **View → Zoom Out / Zoom In** (`Cmd+-` / `Cmd++`), in 10% steps from 50% to 200%, and **Actual Size** (`Cmd+0`); the command palette offers the same actions. Reloading or restarting restores 100%. ([#284](https://github.com/vmaerten/diffdesk/pull/284))

### 🐛 Fixes

- Keep the reading position when the review page reloads after its renderer dies: the view is now saved while reading, not only at `Cmd+R`. With **Debug logging** on, the renderer's termination is recorded in the log. ([#285](https://github.com/vmaerten/diffdesk/pull/285))
- List the hovered use among a Python symbol's references with pyright and basedpyright, which left it out. ([#292](https://github.com/vmaerten/diffdesk/pull/292))
- Keep an open Settings window in step with settings saved from another window, instead of writing its stale values back on its next change. ([#288](https://github.com/vmaerten/diffdesk/pull/288))

### 📚 Documentation

- Record the language server measurements (first hover, references and memory for tsrs, tsc, basedpyright, pyright, ty and gopls) behind the order of servers in Auto. ([#291](https://github.com/vmaerten/diffdesk/pull/291))

### 🔧 Internal

- Check the window size only at startup in the native smoke test. ([#282](https://github.com/vmaerten/diffdesk/pull/282))

## 0.8.0

### ✨ Features

- Use code intelligence on any reviewed branch or commit: Diffdesk prepares an isolated copy of the displayed revision for symbol information, definitions and references, while keeping your checkout and uncommitted edits intact. Copies are reused and cleaned up when the app stops; the IntelliSense diagnostic shows the analyzed version and its location. Project dependencies are not installed automatically. ([#278](https://github.com/vmaerten/diffdesk/pull/278))

### 🐛 Fixes

- Open the window maximised from the terminal, Finder or Dock, instead of leaving it at 1280 × 800. The zoom button still restores that default size. ([#280](https://github.com/vmaerten/diffdesk/pull/280))

## 0.7.1

### 🐛 Fixes

- Let Homebrew manage its metadata refreshes during in-app updates: Diffdesk now runs only `brew upgrade --cask vmaerten/tap/diffdesk`, without forcing a separate `brew update` first. ([#279](https://github.com/vmaerten/diffdesk/pull/279))

## 0.7.0

### ✨ Features

- Update Diffdesk from the app: a bottom banner offers new stable releases without interrupting the review. Choose **Later** to keep working, or **Update…**, then **Update and Restart**, to install through Homebrew or mise and reopen the active comparison. **Diffdesk → Check for Updates…** checks on demand; progress and retryable errors stay in the banner. Save drafts before restarting. ([#276](https://github.com/vmaerten/diffdesk/pull/276))
- Read the proposed release’s changelog under **What’s new in…** before confirming an update, with headings, lists, code and links. The notes and update status stay available after reloading the review. ([#276](https://github.com/vmaerten/diffdesk/pull/276))

### 🔧 Internal

- Accept renamed repository asset URLs when validating published releases through mise. ([#275](https://github.com/vmaerten/diffdesk/pull/275))

## 0.6.0

### ✨ Features

- Enable **Debug logging** in Settings, under Window, to record clicks, mouse buttons, keyboard actions, comments, navigation and scrolling in a local file across reloads and restarts. Every event is kept until you clear the logs from the same pane, which also copies them with the app and WebView versions. Typed text, clipboard contents and source code are excluded. ([#272](https://github.com/vmaerten/diffdesk/pull/272))
- Start a diff search with the selected source text when pressing `Cmd+F`, and replace an open search with a new selection. ([#270](https://github.com/vmaerten/diffdesk/pull/270))
- Check why code intelligence is unavailable with **Check IntelliSense Status…** in the command palette (`Cmd+K`): see the checkout and target, whether the working tree is included, and each language server's state, path, errors and installation command. The diagnostic explains that choosing a target branch does not check it out. ([#271](https://github.com/vmaerten/diffdesk/pull/271))

### 🐛 Fixes

- Hide Git status dots on folders in the file tree, keeping status indicators on individual files. ([#269](https://github.com/vmaerten/diffdesk/pull/269))
- Keep truncated file and folder names legible in the translucent sidebar, instead of drawing the ellipsis over the remaining letters. ([#273](https://github.com/vmaerten/diffdesk/pull/273))
- Point the comparison arrow from the reviewed target toward its base, matching the direction of the merge. ([#268](https://github.com/vmaerten/diffdesk/pull/268))

### 📚 Documentation

- Explain how to trust the renamed Diffdesk cask before upgrading a Homebrew installation from ghl. ([#266](https://github.com/vmaerten/diffdesk/pull/266))

## 0.5.0

### 💥 Breaking changes

- Rename the app Diffdesk, with a new icon: a D cut in two, red for the base and green for the target. The app is `Diffdesk.app` and its command `diffdesk`; Homebrew and `task install` still link `ghl` beside it, but mise puts only `diffdesk` on PATH. Comments and Viewed stay in `.git/ghl/state.json`, settings move to `~/Library/Application Support/Diffdesk` and are read from `ghl` until the first change, and the sidebar and panel widths start over once. ([#260](https://github.com/vmaerten/diffdesk/pull/260))

### 🐛 Fixes

- Draw tabs two columns wide in the symbol card and the Symbol panel, as the diff does, instead of eight, which spread a Go struct across the card. ([#262](https://github.com/vmaerten/diffdesk/pull/262))

### 📦 Distribution

- Publish `diffdesk_<version>_darwin_arm64.zip` and the `diffdesk` cask, which replaces the `ghl` cask. Homebrew trusts a cask by name: run `brew update` and `brew trust --cask vmaerten/tap/diffdesk`, then `brew upgrade --cask diffdesk` replaces `ghl.app` with `Diffdesk.app`, and `rm -rf "$(brew --caskroom)/ghl"` removes the empty `ghl` entry it leaves behind. mise keeps the `github:vmaerten/ghl` tool. The site moves to [diffdesk.vmaerten.fr](https://diffdesk.vmaerten.fr). ([#260](https://github.com/vmaerten/diffdesk/pull/260))

## 0.4.0

### ✨ Features

- Clean up after the browser CLI when the app starts: stop the daemon ghl 0.1 or 0.2 left on port 7777, remove its lock folder, and remove a CLI installed from source in `~/.local/bin/ghl` that would shadow the app's `ghl`. ([#180](https://github.com/vmaerten/diffdesk/pull/180))
- Highlight code in background workers, so scrolling a large review no longer stutters as each file comes into view, and render it about twice as fast. Reviews of thousands of files and checkouts with many branches load faster too. ([#192](https://github.com/vmaerten/diffdesk/pull/192))
- Open the window maximised: it fills the screen with the menu bar and the Dock still visible, and the zoom button brings it back to its former size. ([#200](https://github.com/vmaerten/diffdesk/pull/200))
- Centre the comparison capsule in the title bar; in a narrow window it moves left to keep room for the actions. ([#201](https://github.com/vmaerten/diffdesk/pull/201))
- Show a stacked branch's layer, such as `2/3`, at the start of the comparison in the title bar instead of a line of branches in the status bar: it opens the stack from the top layer down to the trunk, with each pull request and whether a layer is merged or pruned. Press `s` to open it, and `[` or `]` to review the layer below or above. ([#202](https://github.com/vmaerten/diffdesk/pull/202))
- Open a review in place of the one shown instead of in a new tab: running `ghl` in another checkout, or opening a repository with `Cmd+O`, replaces it. ([#203](https://github.com/vmaerten/diffdesk/pull/203))
- Right-click a file in the tree or on its header for a native menu with Viewed, Copy Path and Reveal in Finder on that file. ([#208](https://github.com/vmaerten/diffdesk/pull/208))
- Offer a compact title bar, 38 px instead of 52 with macOS's compact toolbar, to give the code more room: Settings, under Window, turns it on from the next launch. ([#210](https://github.com/vmaerten/diffdesk/pull/210))
- Find Settings… (`Cmd+,`) in the ghl menu, where macOS apps keep it, instead of File. ([#243](https://github.com/vmaerten/diffdesk/pull/243))
- Open Settings in a window of its own, with Appearance, Code and Window panes: the review stays visible beside it and follows each change as you make it. The title bar is a choice between Standard and Compact pictures instead of a checkbox. ([#244](https://github.com/vmaerten/diffdesk/pull/244))
- Code intelligence, in beta: turn it on in Settings, then hold `Cmd` over a symbol for its type and documentation, and `Cmd`-click it to go to its definition, with `Cmd+[` to come back. The answers come from the language servers on your Mac, for working-tree reviews: TypeScript 7 or `tsrs`, `basedpyright`, `pyright` or `ty` for Python, `gopls`, `terraform-ls`, `helm_ls` for Helm charts, and `rust-analyzer`. References opens a Symbol tab beside Comments with the symbol's references in the repository, those in the diff marked and one click away; a setting turns the tab off. Settings show which server each language would use, and the status bar what it is doing. ([#223](https://github.com/vmaerten/diffdesk/pull/223), [#226](https://github.com/vmaerten/diffdesk/pull/226), [#228](https://github.com/vmaerten/diffdesk/pull/228), [#231](https://github.com/vmaerten/diffdesk/pull/231), [#236](https://github.com/vmaerten/diffdesk/pull/236), [#237](https://github.com/vmaerten/diffdesk/pull/237))
- Resolve a comment instead of deleting it: Resolve on a card closes it and keeps it, out of the diff, the panel, the count and Copy. `ghl comments` and Copy show each comment's ID, `ghl comments --all` lists resolved comments too, and `ghl comments resolve <id>` and `reopen <id>` work from the terminal. The review state moves to version 2; an older ghl refuses it instead of reopening resolved comments. ([#227](https://github.com/vmaerten/diffdesk/pull/227))
- Copy comments in a compact text sized for an agent: each comment gives its ID, `path:lines` and body, and quotes only the lines the file no longer has, removed by the change or changed since. `ghl comments` prints the same text, and `--code` quotes every comment's current lines. ([#238](https://github.com/vmaerten/diffdesk/pull/238))
- Show the reviewed branch's GitHub pull request in the title bar: its number with the colour of its state, the local commits GitHub does not have yet and conflicts with its base. Click it for the title, reviews, merge status, what is not pushed, and a link to GitHub. It needs the GitHub CLI, signed in; Settings, under GitHub, says which account it uses and turns it off. ([#242](https://github.com/vmaerten/diffdesk/pull/242))
- Show the pull request's checks, GitHub Actions runs and commit statuses, in its pill: how many fail, how many are done while they run, or a tick. The popover lists them failing first with their logs, says when they ran without your local changes, and follows running checks every 15 seconds while the window is in front. ([#246](https://github.com/vmaerten/diffdesk/pull/246))
- Show the pull request in the status bar instead of the title bar, with Settings, under GitHub: its state, failing checks, unpushed commits and conflicts in words, and the same popover. ([#249](https://github.com/vmaerten/diffdesk/pull/249))
- Open a command palette with `Cmd+K` (View › Command Palette…) to find a command by name instead of through the menus: it lists the commands that apply to the review with their shortcut, and checks those that show a state, such as Split or Ignore Whitespace. ([#251](https://github.com/vmaerten/diffdesk/pull/251))
- Jump to a file of the review by name with `Cmd+P` (Go › Go to File…): the palette lists the files with their folder, line counts and status, and Commands and Files tabs switch between the two lists. ([#253](https://github.com/vmaerten/diffdesk/pull/253))

### 🐛 Fixes

- Comment on every line of a selection that runs from added or unchanged lines into removed ones, instead of only the line where it ended: it now covers the lines of the new file it spans, as does a selection dragged across the columns of the split view. ([#248](https://github.com/vmaerten/diffdesk/pull/248))
- Stop a base picked in the window from emptying a branch's reviews for good: the base is now dimmed text in the title bar, so a click meant for the reviewed branch no longer opens the base picker, the pickers open on the current choice so Enter alone changes nothing, and a picked base holds for the review shown instead of being written to `.git/config`. **Automatic base** drops it, and a review whose base already contains the whole branch says so and offers the automatic base. Bases that earlier releases remembered in `branch.<name>.ghlBase` are ignored. ([#218](https://github.com/vmaerten/diffdesk/pull/218))
- Read the review whatever diff prefixes Git is configured with (`diff.mnemonicPrefix`, `diff.noprefix`, `diff.srcPrefix`), instead of losing Viewed, comments and context on every file; with `diff.suppressBlankEmpty`, comments after a blank line now anchor on the right code. ([#184](https://github.com/vmaerten/diffdesk/pull/184))
- Open the window when ghl is launched from the Finder, Spotlight or the Dock, instead of failing with "Could not open repository"; error dialogs show the message rather than the server's JSON, and a `ghl` run while the app quits opens in a new window instead of being lost. ([#185](https://github.com/vmaerten/diffdesk/pull/185))
- Keep reviews and `ghl comments` working after a crash left the state lock behind, and in reftable repositories: only writes lock the state now, with a lock the system releases when a process dies. Reading a corrupt state no longer moves it aside; the next comment or Viewed change does. ([#186](https://github.com/vmaerten/diffdesk/pull/186))
- Keep the review's keys and position right when the comparison changes: an open comment whose line leaves the diff no longer blocks the single-letter shortcuts, `j`, `k` and `v` follow the file you scrolled to, search no longer jumps back to a match when you tick Viewed, context still expands after a failed refresh, and a Viewed tick survives switching tabs while it saves. The target picker is labelled as such, and the comments panel lists files in the tree's order. ([#187](https://github.com/vmaerten/diffdesk/pull/187))
- Refuse review writes that are not JSON, so a web page served on another localhost port can no longer add or delete comments or change Viewed. ([#188](https://github.com/vmaerten/diffdesk/pull/188))
- Review and export comments during a merge, rebase, cherry-pick or revert, with a warning naming the conflicted files; a stopped rebase keeps the branch's comments. Untracked symlinks, special files and files over 20 MB are left out with a notice instead of failing the review, comments on non-UTF-8 lines no longer turn stale, file names with a backslash can be commented on, and image previews work in folders whose name holds `#`, `?` or `%`. ([#189](https://github.com/vmaerten/diffdesk/pull/189))
- Expand context and keep comments fresh on files with a textconv driver or a CRLF checkout (`eol=crlf`, `core.autocrlf`), instead of asking for a refresh every time. Files are shown as Git stores them, without textconv, and files other filters such as Git LFS rewrite say context is unavailable. ([#190](https://github.com/vmaerten/diffdesk/pull/190))
- Keep a file's header opaque to its corners while it stays at the top of a scrolled review, instead of letting the code show through its rounded top left. ([#199](https://github.com/vmaerten/diffdesk/pull/199))

### 📦 Distribution

- Build with Go 1.27.3, which fixes standard library vulnerabilities in `net/http`, `crypto/x509` and `os`. `brew uninstall --cask --zap ghl` also removes the app's caches and web data, and the installation guide covers downloading the zip from the release page. Releases run one at a time and never move the cask back to an older version. ([#191](https://github.com/vmaerten/diffdesk/pull/191))
- Run the app on Wails v3 (v3.0.0-beta.34) instead of Wails v2: with two reviews open it uses 16 to 46 MiB less memory, and switching reviews is slightly faster. ([#207](https://github.com/vmaerten/diffdesk/pull/207))

## 0.3.1

### 🐛 Fixes

- Open the review when `ghl` runs with another or no `TMPDIR`, as in some tool environments, instead of failing with "the ghl app did not start". ([#178](https://github.com/vmaerten/diffdesk/pull/178))

## 0.3.0

ghl is now a macOS app. `ghl` opens or activates a review tab in one native window instead of serving the review to a browser. Comments and Viewed stay in the same `.git/ghl/state.json`, and settings saved by the earlier `ghl Desktop` build are read until the first change.

### 💥 Breaking changes

- Replace the browser CLI, its shared daemon on port 7777 and the `ghl.localhost` URLs with the app's own window. `ghl comments [--json]` and `ghl --version [--json]` still print in the terminal; `--port`, `--no-open`, `--no-daemon`, `--idle`, `--print`, `--import-state` and `GHL_PORT` are removed. ([#167](https://github.com/vmaerten/diffdesk/pull/167), [#169](https://github.com/vmaerten/diffdesk/pull/169), [#171](https://github.com/vmaerten/diffdesk/pull/171))
- Ship one archive, `ghl_<version>_darwin_arm64.zip` with `ghl.app`, for macOS 13 or later on Apple Silicon. Linux and macOS Intel stay on 0.2.0. ([#172](https://github.com/vmaerten/diffdesk/pull/172))

### ✨ Features

- Review in a macOS-style window: review tabs in a unified title bar holding the comparison controls, a translucent file sidebar, files as cards, a comments side panel beside the diff, a status bar and native menus. ([#155](https://github.com/vmaerten/diffdesk/pull/155)–[#164](https://github.com/vmaerten/diffdesk/pull/164))
- Choose the appearance (System, Light or Dark), a syntax theme for each mode and the code font and size in Settings. ([#157](https://github.com/vmaerten/diffdesk/pull/157))

### 🐛 Fixes

- Open every review requested while the app is still starting, once each; a launch that cannot reach the app now fails with an error instead of returning silently. ([#136](https://github.com/vmaerten/diffdesk/issues/136))

### 📦 Distribution

- Install with Homebrew, `brew install --cask vmaerten/tap/ghl`, or keep mise's `github:vmaerten/ghl`, which moves to the app on upgrade. ([#173](https://github.com/vmaerten/diffdesk/pull/173))

## 0.2.0

### ✨ Features

- Add an **Ignore whitespace** control that filters whitespace-only changes and updates file and line counts. Preserve the choice in the URL, keep separate Viewed ticks for each mode, and retain comments on hidden files in the panel. ([#147](https://github.com/vmaerten/diffdesk/pull/147))
- Open the default Linux browser through `xdg-open`. ([#143](https://github.com/vmaerten/diffdesk/pull/143))

### 🐛 Fixes

- Keep comments on their original branch across branch switches and restarts, including in the comments panel, pending saves and CLI exports. ([#148](https://github.com/vmaerten/diffdesk/pull/148))
- Use the fetched remote trunk when the local trunk is strictly behind it, avoiding unrelated upstream changes in the review. Keep local branches that are ahead or diverged, without fetching or changing the checkout. ([#83](https://github.com/vmaerten/diffdesk/pull/83))
- Keep rapid Viewed toggles and resets in order, prevent refreshes from restoring older state, and roll back failed saves without replacing newer actions. ([80110a1](https://github.com/vmaerten/diffdesk/commit/80110a185f796adf4d652420af50689447716f43))
- Preserve a comment's first saved code anchor, creation time and original comparison when retrying a save, including after code changes. ([933b847](https://github.com/vmaerten/diffdesk/commit/933b847b8452c7ead0d4bce553c27e5d3a293031))
- Wrap review controls on narrow mobile screens so the whitespace control does not cause horizontal overflow. ([bdd7f75](https://github.com/vmaerten/diffdesk/commit/bdd7f7505543ca8b56255c3288628fd9e40d22ac))

### 📦 Distribution

- Add release build targets for macOS Intel, Linux ARM64 and Linux x86-64. ([#144](https://github.com/vmaerten/diffdesk/pull/144))
- Validate every archive's checksum, layout and Go OS/architecture settings; exercise platform-specific CLI, browser and mise installation gates locally.

### 📚 Documentation

- Shorten the README and move detailed usage into a dedicated reviewing guide. ([#150](https://github.com/vmaerten/diffdesk/pull/150))

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

Stop an old Node daemon before starting Go on the same port. Read the [migration guide](https://github.com/vmaerten/diffdesk/blob/v0.1.0/docs/migration.md) for PATH precedence, backups and rollback, and the [installation guide](https://github.com/vmaerten/diffdesk/blob/v0.1.0/docs/go-installation.md) for mise commands. Other platforms and the optional URL without a port remain follow-up work.
