# Release acceptance

Releases target **macOS ARM64**, from macOS 13. Pull requests and branch pushes do not run CI; stable version tags run the hosted release job. Maintainers run the locked toolchain and Chrome for Testing 154.0.8037.92 locally.

## Local gate

From the checkout, with the locked tools installed:

```bash
mise install --locked
pnpm install --frozen-lockfile
task test:browser:install
task check
task test
task desktop:smoke
task release:check
task release:snapshot
task release:mise
```

The browser installer downloads into the ignored `.task/browser/` directory, and the UI harness prefers that exact build; `CHROME_PATH` can choose another executable. Chrome, Python and the C toolchain used by `-race` are test prerequisites, excluded from the release archive. For a checked-out version tag, substitute `RELEASE_TAG=vX.Y.Z task release:build` for the snapshot step; see [releases](./releases.md). Run `task test:dev` when changing the development loop.

## What each gate covers

| Gate | Behavior exercised |
| --- | --- |
| `task test` | Go race tests, state concurrency and schema compatibility (`goState.ts`), revision contracts (`goRevisions.ts`), image API and previews (`goImages.ts`), the shared UI suites on the built desktop UI (`run.ts`), tab restoration (`desktopTabs.ts`), the desktop Go tests and the release flow |
| `task desktop:smoke` | The real WebKit window on fixtures: comments, the native clipboard, Viewed, tabs, reuse of the running window, Settings, menus, shutdown and restart |
| `release:snapshot` | The archive itself: checksum, members, bundle metadata, minimum macOS, notices, signature, `ghl --version` and the native smoke test on the extracted app outside the checkout |
| `release:mise` | Installation through the real mise client: PATH, shims, terminal commands with only Git, the window from the mise install, upgrade, rollback, corrupt downloads and uninstall |

The UI suites run several at once, each on its own fixture and browser context; `GHL_TEST_JOBS` sets how many. They drive the production UI with the Wails bindings simulated by `desktop/simulator.ts`, while `desktop:smoke` drives the real native window. Neither opens your Chrome profile or changes a real repository; the clipboard check writes fixture Markdown to the system clipboard.

## Promotion policy

The [mise checks](./installation.md#maintainer-verification) exercise the real client against a local release API before publication, and the actual GitHub assets afterward. Run all relevant local checks before pushing a release tag: the tag-only workflow verifies the archive and runs the native smoke test through `task release`, but not the UI or mise suites. Validation runs on macOS 26 only; the minimum of macOS 13 is checked in the executable and the bundle, not by launching on an older release. Measurements check correctness and impose no RAM or latency threshold.
