# Releases

A release is one archive, `diffdesk_<version>_darwin_arm64.zip`, with its SHA-256 in `checksums.txt`. It holds `Diffdesk.app`, the project's MIT license and the notices of every third-party component it ships. The app runs on macOS 13 or later on Apple Silicon and needs Git. Consumers install it through [Homebrew or mise](../site/src/content/docs/guide/installation.md).

## Local snapshot

Use [mise](https://mise.jdx.dev/) to install the exact tool versions in `.mise.toml` and the download checksums in `mise.lock`:

```bash
mise install --locked
mise exec -- task release:check
mise exec -- task release:snapshot
```

This invokes GoReleaser OSS 2.18.2. Its before hooks install the frozen pnpm lockfile, generate the frontend and Go standard library notices, build the app with `task desktop:build`, then extend the notices with the Go modules actually linked into it. Task builds the app natively with cgo for Wails, targeting macOS 13: without a deployment target, cgo would target the installed SDK's release. It embeds the production UI, stamps the release version, full commit and commit date into the executable and the bundle, and signs the bundle ad hoc. GoReleaser has no Go build of its own; it packages the bundle as a `meta: true` ZIP whose explicit destinations keep `Contents/MacOS` and `_CodeSignature`, and writes the checksum.

Outputs live in `go/dist/release/`:

| File | Content |
| --- | --- |
| `diffdesk_<version>_darwin_arm64.zip` | `Diffdesk.app`, `LICENSE` and `THIRD_PARTY_NOTICES.txt` |
| `checksums.txt` | SHA-256 of the archive, with its exact filename |
| `metadata.json`, `artifacts.json` | Local GoReleaser build records |

Snapshot versions use `<latest-version>-next-<short-commit>`. The date is the commit's UTC timestamp, which keeps the version stamp and the archive's file times stable across builds.

`task release:snapshot` ends with `task release:verify`, which runs `desktop/release.py verify`. Before extracting anything, it checks the checksum and rejects unexpected or duplicate ZIP members, links and an executable without its executable mode. It then verifies the bundle metadata, including `LSMinimumSystemVersion`, the executable's `minos` of 13.0, the license and notices, the Go build settings and the ad hoc signature. It runs `diffdesk --version` from the extracted app with only system tools on PATH and checks its build date against the commit. With `RELEASE_TAG` set, the archive must also match the tag. `task desktop:test` includes the ZIP and checksum guard tests.

## Version tags and publication

Set `package.json` to the intended version and commit it with the release's notes in `CHANGELOG.md`, under `## X.Y.Z`: rename `## Unreleased`, where each PR adds its entry. Group the entries under these headings, in this order, and keep only those with entries: `### 💥 Breaking changes`, `### ✨ Features`, `### 🐛 Fixes`, `### 📦 Distribution`, `### 📚 Documentation` and `### 🔧 Internal`. That section, without its heading, becomes the GitHub release notes; `release:build` fails when it is missing or empty. Supported versions are `X.Y.Z` and `X.Y.Z-prerelease`, with a matching `v`-prefixed tag on that commit. Before pushing the tag, run the native smoke test, then tag the commit locally (`release:build` resolves `RELEASE_TAG` to a commit) and build and verify the archive from its clean checkout:

```bash
mise exec -- task desktop:smoke
git tag v0.3.0
RELEASE_TAG=v0.3.0 mise exec -- task release:build
git push origin refs/tags/v0.3.0
```

The `Release` GitHub workflow runs only when a stable `vX.Y.Z` tag is pushed. A single `macos-26` ARM64 job checks out the tag's commit, installs the locked tools through mise 2026.10.2 and runs `task release`. Actions are pinned by commit, only the release job receives `contents: write`, and releases run one at a time: a second tag waits instead of racing the first to the cask. On this repository, the hosted job consumes the account's included minutes.

`task release` resolves the tag from `RELEASE_TAG`, an explicit `TAG` or the exact tag on HEAD, then:

1. builds and verifies the archive, as above;
2. checks that the Homebrew tap is reachable and, in the workflow, that `HOMEBREW_TAP_TOKEN` is set, so a missing token fails before anything is published;
3. creates a draft release with the archive and `checksums.txt`, and publishes it only once both uploads succeed;
4. renders `desktop/cask.rb` from the published `checksums.txt` and pushes it to `Casks/diffdesk.rb` in [vmaerten/homebrew-tap](https://github.com/vmaerten/homebrew-tap), unless the tap already offers a newer version. While the tap still has `Casks/ghl.rb`, the cask's name before the app became Diffdesk, it adds `cask_renames.json` so `brew upgrade` moves those installs to `diffdesk`, then removes the old cask.

An existing release is never overwritten; a failed upload leaves a draft to inspect. Prereleases are published by running `task release TAG=vX.Y.Z-rc.N` locally; they are marked as such and leave the cask on the last stable release.

The workflow's own token reaches only this repository. The cask push uses the `HOMEBREW_TAP_TOKEN` secret: a fine-grained token with `contents: write` on `vmaerten/homebrew-tap` alone. If the push fails after publication, rerun it on its own:

```bash
task release:tap TAG=v0.3.0
```

From a clean checkout whose tag already exists on GitHub, an authenticated maintainer can also run `task release TAG=v0.3.0`; do not run it concurrently with the workflow. Test the ordering and failure paths without any GitHub write:

```bash
task test:release
```

After publication, check the real download through mise, then through Homebrew on a session without development tools:

```bash
task release:mise:published VERSION=0.3.0 PREVIOUS=0.2.0
brew install --cask vmaerten/tap/diffdesk
```

There is no paid signing or notarisation. Stable builds offer in-app updates through the Homebrew or mise installation that owns their bundle; see [installation](../site/src/content/docs/guide/installation.md#after-installing-upgrading-or-rolling-back). The updater reads the latest stable GitHub release and requires its Apple Silicon ZIP asset before offering it. If publication succeeds before the tap is updated, the updater verifies the installed version and keeps the app running until the cask catches up. Go, Node, pnpm, Task and GoReleaser stay pinned in `.mise.toml`, with download checksums in `mise.lock`.

## mise acceptance


Use mise **2026.10.2**; `DIFFDESK_TEST_MISE` can point at that binary. All mise configuration, data, cache and state live in temporary directories outside the checkout: the tests change neither your mise configuration nor a global `diffdesk`.

```bash
task release:snapshot
task release:mise

# Once releases exist; PREVIOUS is optional:
task release:mise:published VERSION=X.Y.Z
task release:mise:published VERSION=X.Y.Z PREVIOUS=A.B.C
```

Before publication, `release:mise` routes the real mise GitHub client to a loopback API with mise's URL replacement setting. It serves the candidate archive, a predecessor (the candidate with another bundle marker, signed again), a prerelease and a corrupt download. It checks autodetection, the checksum fallback, activation and shims, `diffdesk --version` and `diffdesk comments` with only Git on PATH, the absence of quarantine and a valid signature, the window opened from the mise install, exact pins, `mise upgrade`, rollback, the corrupt download and uninstall. It creates no tag or release; it is fixture coverage, not evidence of a published download.

Published mode downloads the actual GitHub assets, compares the installed executable with the checksummed archive, and upgrades from `PREVIOUS` when given; that version may be a 0.2.0-era CLI tarball. `GITHUB_TOKEN` or `GH_TOKEN` can authenticate the reads, without write access. The tests set `GHL_PORT=0`, so an old CLI can never start or replace a daemon on your own port. Reports land in `.task/mise-acceptance.json` and `.task/mise-published.json`, starting with `complete: false`.

References: [GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html), [release age](https://mise.jdx.dev/configuration/settings.html#minimum_release_age), [URL replacements](https://mise.jdx.dev/url-replacements.html).

## License material

`scripts/release-notices.ts` collects the installed production JavaScript package closure, preserving complete LICENSE and NOTICE files, and the Go standard library license. It fails on missing material. Two npm packages need special handling: `lru_map` puts its MIT text in its packaged README, while `react-remove-scroll-bar@2.3.8` uses the reviewed immutable upstream license in `scripts/licenses/`. Shiki's vendored Oniguruma, grammar and theme notices are also preserved from their exact upstream versions; their sources and version guards are documented in `scripts/licenses/README.md`. An upgrade with missing notices requires reviewing its license source before proceeding. Generated notices stay in `.task/release/`.

`desktop/release.py notices` extends that material with the LICENSE and NOTICE files of the Go modules actually linked into the app, including Wails. Missing material or a linked version mismatch stops the build. Its output, `.task/desktop/THIRD_PARTY_NOTICES.txt`, is the archive's notice file.

References: [Archives](https://goreleaser.com/customization/package/archives/), [GoReleaser templates](https://goreleaser.com/customization/general/templates/).
