# Releases

A release is one archive, `ghl_<version>_darwin_arm64.zip`, with its SHA-256 in `checksums.txt`. It holds `ghl.app`, the project's MIT license and the notices of every third-party component it ships. The app runs on macOS 13 or later on Apple Silicon and needs Git. Consumers install it through [Homebrew or mise](./installation.md).

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
| `ghl_<version>_darwin_arm64.zip` | `ghl.app`, `LICENSE` and `THIRD_PARTY_NOTICES.txt` |
| `checksums.txt` | SHA-256 of the archive, with its exact filename |
| `metadata.json`, `artifacts.json` | Local GoReleaser build records |

Snapshot versions use `<latest-version>-next-<short-commit>`. The date is the commit's UTC timestamp, which keeps the version stamp and the archive's file times stable across builds.

`task release:snapshot` ends with `task release:verify`, which runs `desktop/release.py verify`. Before extracting anything, it checks the checksum and rejects unexpected or duplicate ZIP members, links and an executable without its executable mode. It then verifies the bundle metadata, including `LSMinimumSystemVersion`, the executable's `minos` of 13.0, the license and notices, the Go build settings and the ad hoc signature. It runs `ghl --version` from the extracted app with only system tools on PATH and checks its build date against the commit. With `RELEASE_TAG` set, the archive must also match the tag. `task desktop:test` includes the ZIP and checksum guard tests.

## Version tags and publication

Set `package.json` to the intended version and commit it with the release's changes and notes in `CHANGELOG.md`. Supported versions are `X.Y.Z` and `X.Y.Z-prerelease`, with a matching `v`-prefixed tag on that commit. Before pushing the tag, run the native smoke test, then build and verify the same archive from its clean checkout:

```bash
mise exec -- task desktop:smoke
RELEASE_TAG=v0.3.0 mise exec -- task release:build
git tag v0.3.0
git push origin refs/tags/v0.3.0
```

The `Release` GitHub workflow runs only when a stable `vX.Y.Z` tag is pushed. A single `macos-26` ARM64 job checks out the tag's commit, installs the locked tools through mise 2026.10.2 and runs `task release`. Actions are pinned by commit, only the release job receives `contents: write`, and reruns of the same tag cannot cancel an ongoing release. On this repository, the hosted job consumes the account's included minutes.

`task release` resolves the tag from `RELEASE_TAG`, an explicit `TAG` or the exact tag on HEAD, then:

1. builds and verifies the archive, as above;
2. checks that the Homebrew tap is reachable, so a missing token fails before anything is published;
3. creates a draft release with the archive and `checksums.txt`, and publishes it only once both uploads succeed;
4. renders `desktop/cask.rb` from the published `checksums.txt` and pushes it to `Casks/ghl.rb` in [vmaerten/homebrew-tap](https://github.com/vmaerten/homebrew-tap).

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
brew install --cask vmaerten/tap/ghl
```

There is no paid signing, notarisation or automatic update. Go, Node, pnpm, Task and GoReleaser stay pinned in `.mise.toml`, with download checksums in `mise.lock`.

## License material

`scripts/release-notices.ts` collects the installed production JavaScript package closure, preserving complete LICENSE and NOTICE files, and the Go standard library license. It fails on missing material. Two npm packages need special handling: `lru_map` puts its MIT text in its packaged README, while `react-remove-scroll-bar@2.3.8` uses the reviewed immutable upstream license in `scripts/licenses/`. Shiki's vendored Oniguruma, grammar and theme notices are also preserved from their exact upstream versions; their sources and version guards are documented in `scripts/licenses/README.md`. An upgrade with missing notices requires reviewing its license source before proceeding. Generated notices stay in `.task/release/`.

`desktop/release.py notices` extends that material with the LICENSE and NOTICE files of the Go modules actually linked into the app, including Wails. Missing material or a linked version mismatch stops the build. Its output, `.task/desktop/THIRD_PARTY_NOTICES.txt`, is the archive's notice file.

References: [Archives](https://goreleaser.com/customization/package/archives/), [GoReleaser templates](https://goreleaser.com/customization/general/templates/).
