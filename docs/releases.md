# Releases

The release pipeline builds one executable containing the production React UI.
The configured targets are macOS ARM64/Intel and Linux ARM64/x86-64. Git and
a browser are runtime prerequisites. The project uses MIT; archives also contain the notices for
third-party components. The [mise installation guide](./installation.md)
documents the consumer path and its verification. The first release, v0.1.0,
was published for macOS ARM64 and passed the real GitHub/mise installation gate.
The v0.2.0 release adds the other three archive targets.

## Local snapshot

Use [mise](https://mise.jdx.dev/) to install the exact tool versions in
`.mise.toml` and the download checksums in `mise.lock`:

```bash
mise install --locked
mise exec -- task release:check
mise exec -- task release:snapshot
```

This invokes GoReleaser OSS 2.18.2. Its before hooks install the frozen pnpm
lockfile, build Vite in `go` mode and generate dependency notices. GoReleaser
then compiles `go/cmd/ghl` with `CGO_ENABLED=0`, `-trimpath`, `-s -w`, and version,
full commit and date metadata. The date is the commit's UTC timestamp, which
keeps the version stamp and archive file times stable for repeated builds.
The isolated PoC is outside the release configuration.

Outputs live in `go/dist/release/`:

| File                                | Content                                            |
| ----------------------------------- | -------------------------------------------------- |
| `ghl_<version>_darwin_arm64.tar.gz` | macOS Apple Silicon CLI, license and notices       |
| `ghl_<version>_darwin_amd64.tar.gz` | macOS Intel CLI, license and notices               |
| `ghl_<version>_linux_arm64.tar.gz`  | Linux ARM64 CLI, license and notices               |
| `ghl_<version>_linux_amd64.tar.gz`  | Linux x86-64 CLI, license and notices              |
| `checksums.txt`                     | SHA-256 of all four archives, with exact filenames |
| `metadata.json`, `artifacts.json`   | Local GoReleaser build records                     |

Snapshot versions use `<latest-version>-next-<short-commit>`, or start at
`0.0.0` when no version tag exists. The archive naming pattern is predictable
for download clients and mise. React HTML, JavaScript, CSS and other generated
assets live inside the executable. Toolchains, node_modules and test browsers
are excluded from the archive.

`task release:snapshot` finishes by verifying checksums and the exact contents
of every archive; wrong-architecture and duplicate-checksum guards are included. It extracts the executable into a temporary directory outside the
checkout and runs it with only Git in PATH. The checks cover `--version --json`,
health metadata, a production diff with untracked files, clean shutdown and
embedded HTML/JavaScript/CSS responses. Guard tests reject corrupt checksums,
wrong commit metadata, unexpected files, symlinks and invalid/stale version tags.
Every archive is checked for contents, checksum, licenses and embedded Go
OS/architecture settings. The validator then executes the selected host archive.
`GHL_TEST_TARGET=darwin_amd64` can select Intel execution under Rosetta on Apple
Silicon; this is reported separately from native hardware coverage.

## Version tags and publication

Set `package.json` to the intended version and commit it with the release's
changes. Supported versions are `X.Y.Z` and `X.Y.Z-prerelease`, with a matching
`v`-prefixed tag on that commit. Before pushing a release tag, the same archives
can be built and verified locally from its clean checkout:

```bash
RELEASE_TAG=v0.2.0 mise exec -- task release:build
```

Replace the example with the checked-out tag. The command checks that it matches
`package.json` and points at HEAD. GoReleaser's non-snapshot mode requires a
clean checkout. Both local tasks leave publication disabled in the configuration.

GitHub Actions is disabled for this repository and there is no CI workflow.
Pull requests, branch pushes and tags do not start hosted jobs. Build, acceptance
and publication run locally on the supported native macOS ARM64 target.

After building the checked-out version tag, run the complete
[local acceptance gate](./validation.md), including the extracted archive,
mise fixture on the primary platform, plus [smoke checks](./validation.md#platform-validation)
on the other targets.
Publish those exact tested files without
rebuilding:

```bash
git push origin refs/tags/v0.2.0
gh release create v0.2.0 --verify-tag --title v0.2.0 --notes-file CHANGELOG.md \
  go/dist/release/ghl_0.2.0_*.tar.gz go/dist/release/checksums.txt
task release:mise:published VERSION=0.2.0 PREVIOUS=0.1.0
```

Replace the version in every command when preparing another release. Add
`--prerelease` for a prerelease tag. An existing release fails rather than
replacing its files. The authenticated GitHub CLI needs permission to create
releases; GoReleaser never publishes directly. GitHub Releases and mise remain
the consumer distribution channels.

The last task downloads the actual published assets through mise and exercises
the installed executable, state and lifecycle. Node is a local test driver
outside the consumer PATH; no Go/pnpm build is used to install the release. It
never deletes or replaces release assets. See the installation guide for the
first-release limitations on historical upgrades.

Go, Node, pnpm, Task and GoReleaser remain pinned in `.mise.toml`, with download
checksums in `mise.lock`.

## License material

`scripts/release-notices.ts` collects the installed production JavaScript
package closure, preserving complete LICENSE and NOTICE files, and the Go
standard-library license. It fails on missing material. Two npm packages need
special handling: `lru_map` puts its MIT text in its packaged README, while
`react-remove-scroll-bar@2.3.8` uses the reviewed immutable upstream license in
`scripts/licenses/`. Shiki's vendored Oniguruma, grammar and theme notices are
also preserved from their exact upstream versions. Their sources and version
guards are documented in `scripts/licenses/README.md`. An upgrade with missing
notices requires reviewing its license source before proceeding. Generated
notices stay in `.task/release/`.

The generator handles license material for the embedded frontend. The Taskfile
and GoReleaser call Go directly; there is no TypeScript build wrapper for Go.

References: [Go builds](https://goreleaser.com/customization/builds/builders/go/),
[GoReleaser templates](https://goreleaser.com/customization/general/templates/).
