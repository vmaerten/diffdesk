# The ghl app

ghl opens the Go review server and the React interface in one reusable native window. It is built with Wails v3, pinned to v3.0.0-beta.34, for macOS 13 or later on Apple Silicon.

## Run

From the repository root, with pnpm dependencies installed, Go >= 1.25, Task v3 and Xcode Command Line Tools:

```bash
task desktop:run -- --repo .
task desktop:run -- --repo /path/to/another/repository --base main
```

The task builds an embedded React release and a locally signed application in `.task/desktop/ghl.app`. The terminal returns after opening the window. Later launches replace the shown review in the same window and bring it back from a minimised state; repeating the shown comparison does not reload its page. `Cmd+W` closes the review and leaves the welcome screen open.

Review tabs are off for now: `GHL_DESKTOP_TABS=1` turns them back on, and the smoke tests run with it. A tab identifies a canonical checkout and its base/target parameters; repeated commands activate an existing matching tab. Commit, Working tree and Untracked selections belong to that tab's view and survive switching.

The tab strip supplies selection, per-tab close buttons and **+** to open a repository. Arrow keys, Home and End navigate the focused tab strip. `Cmd+W` closes the active tab; closing the last tab leaves the welcome screen open. Only the active React review is mounted. Inactive tabs retain their route and label, not their parsed patch, DOM or a hidden review component. Each tab also keeps a small, versioned saved view: unified/split mode, scroll position, selected lines, inline composer text, comment-panel edits and context-expansion coordinates. These survive switching and `Cmd+R`; `Ctrl+Tab` and `Ctrl+Shift+Tab` cycle reviews. A user interaction cancels a pending scroll restoration. Expansion replay checks each file's diff hash before applying it. Saved views remain in memory, with a 2 MiB per-tab limit. Closing a tab discards its unsaved drafts; quitting the application discards all saved views and the tab list. Saved comments and Viewed remain durable in repository state.

For daily use from a checkout, link the command to the built bundle:

```bash
task install
ghl                            # current repository, automatically resolved base
ghl feature --repo ../another-repository --base main
ghl comments --json            # this comparison's comments, without a window
ghl --help
```

Installation creates a symlink in `~/.local/bin` pointing to the local bundle; that directory must be on PATH. `BIN_DIR` overrides the command directory. Keep the bundle at its build location while using that link. `task install` replaces the browser CLI that 0.1 and 0.2 copied there, and refuses to replace any other file that is not a link; `task uninstall` removes only the link. Released builds install through [Homebrew or mise](../site/src/content/docs/guide/installation.md).

`ghl comments`, including `ghl comments resolve` and `reopen`, and `ghl --version` answer in the terminal and never reach the window. Any other invocation delivers its review to the running app, or starts the app first, and returns once the app has queued it.

The application menu supplies **ghl → Settings…** (`Cmd+,`), **File → Open repository** (`Cmd+O`), native Edit commands, close tab (`Cmd+W`), reload (`Cmd+R`) and quit (`Cmd+Q`). Closing the window quits the app.

The app uses its own neutral light and dark palettes. Settings is a window of its own, with five panes: Appearance (System follows macOS, or Light or Dark, and one syntax theme for each mode), Code (font and size), Window (standard or compact title bar), Intelligence (the beta language servers) and GitHub (whether to show the reviewed branch's pull request through the GitHub CLI). It saves each change at once, and Go sends the saved settings to every window, so the review follows. The title bar applies at the next launch, since Wails sets a window's toolbar style only when it creates the window. `Cmd+W` closes Settings when it is in front, and closing the review closes it too. Settings persist in `~/Library/Application Support/ghl/settings.json`; settings saved by the earlier `ghl Desktop` app are read until the first change. A font that is not installed falls back to SF Mono, and Settings says so. Git and macOS system WebKit are the runtime requirements; a copied bundle needs no Node, pnpm, Task or Go.

## App icon

The editable icon is `icon/AppIcon.svg`; `icon/AppIcon.png` is its transparent 1024px export. It carries the green/red diff language into a macOS document mark. Export an updated SVG as a transparent 1024×1024 PNG when changing the design. The desktop build uses only macOS `sips` and `iconutil` to create the 16–1024px normal/Retina icon sizes. The desktop build copies the ICNS into `Contents/Resources` before signing; the release ZIP retains that resource and checks its bundle declaration and container.

## Release archive

`task release:snapshot` packages the complete `ghl.app`, the project MIT license and notices for the embedded frontend, Go standard library and linked Go dependencies as `ghl_<version>_darwin_arm64.zip`. The bundle is signed ad hoc, without Apple notarisation, and declares macOS 13 as its minimum. The [release guide](../docs/releases.md) covers its verification, the tag-only release workflow and the Homebrew cask. `task release:snapshot` and `task desktop:build` never publish.

## What is preserved

The React interface keeps its files/tree, unified/split diffs, context expansion, comments, Viewed, syntax themes, search, revision selectors and shortcuts. Markdown/file-name copy uses the native macOS clipboard through Wails. Comments and Viewed use the version-1 `.git/ghl/state.json`, including worktree-specific Git directories.

One Go process owns the native window and the [review server](../go/README.md). It binds a private ephemeral loopback port and stops on window close, quit or a termination signal. Reopening another repository registers it in that same runtime; there is no companion executable or separate server process. A bad repository/ref reports an error while keeping the current review. Selection failures occur in the window after the launcher has returned.

The Wails module depends on the review server's Go module through a local module replacement. Its dependencies stay in the desktop module; the server module keeps its standard-library-only dependency set. The asset handler serves each page with `native.js`, which builds the interface the page expects from Wails' own runtime script, and forwards the rest to the owned runtime, translating only the private `wails://localhost` origin. The public runtime Host/Origin checks remain intact, and accept only `http` and `https` origins.

One app runs per user. It holds a lock file and listens on a Unix socket beside it, in the per-user temporary directory, before its backend or window starts. The launcher resolves relative paths from the terminal, sends the canonical request over that socket and waits for the app to queue it. With no app listening, it starts one through LaunchServices, which gives the window its Dock identity, and delivers once it listens; launchers that start apps at the same time all deliver to the one that wins the lock. Wails' own single-instance lock is not used: it listens only after the app has finished launching, and dropped requests sent in between. Requests from the socket are untrusted input, parsed with the same small argument surface. The asset handler adds the native runtime to every review page, so it survives a reload. Tab navigation changes history and remounts the active review within the same native document. Revision numbers on native tab snapshots reject old replies.

## Validation and limitations

```bash
task desktop:test
task desktop:smoke
# Verify a relocated bundle without Node/pnpm/Go in PATH, after building:
python3 desktop/smoke.py --standalone
```

`task test` runs the shared UI suites on the built desktop UI in headless Chrome, with the same simulated bindings; the native checks below cover what they cannot.

Race tests exercise argument handling, caller-directory preservation, invalid repos/refs, the shared in-process backend, comment persistence, shutdown and the native/public origin boundary, tab identity/closing, stale route updates and concurrent opens. The smoke test opens the real WebKit window on two temporary repositories. It exercises context expansion, UI comment creation/edit/deletion, Markdown copy checked against the OS clipboard, Viewed, relative Unicode paths from another caller, reuse of the same process/window, unminimising, CLI deduplication, UI tab closing, one mounted review, the empty welcome screen, the appearance and code size applied from Settings, shutdown and state restoration after restarting. It writes `.task/desktop/validation.json` and `.task/desktop/smoke.log`. The standalone mode copies the complete bundle outside the checkout and reruns the same native checks with only the system tools/Git in PATH.

The native suite also checks restoration of an inline draft on expanded context, scroll, panel editing, `Ctrl+Tab` and reload with drafts. Go tests check view-copy isolation, version/size validation and late saves for closed tabs.

The optional `GHL_DESKTOP_PROBE` path is a local acceptance-test script injected into the native document; it is unused in normal launches. Its unique path also isolates the test's instance lock, so fixture opens cannot join a user's running app. Smoke runs point `GHL_DESKTOP_SETTINGS` at a temporary file, so they never read or change your settings, and set `GHL_DESKTOP_TABS=1` to check the tabs. Tests do not open your personal Chrome or mutate a real repository. The clipboard check writes fixture Markdown to the system clipboard.

`desktop/cold.py`, part of `task desktop:smoke`, launches two reviews and a duplicate at once on a cold app, three times: every review opens once, in one app.

Builds are manual/local with ad hoc signing. Release signing, notarisation and automatic updates are not configured. Stable release tags run a hosted macOS job through `task release`; PRs and branch pushes do not run CI. Native hot reload is not configured; `task dev` runs the UI in a browser, on the Wails bindings simulated by `simulator.ts`, with React hot reload. Quit the app before rebuilding to load new embedded UI/server code. Linux/Windows, native image interactions and restoration against a substantially changed diff remain outside this validation.
