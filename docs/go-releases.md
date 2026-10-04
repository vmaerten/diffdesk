# Go releases

The release pipeline builds one executable containing the production React UI.
The first supported target is macOS ARM64. Git and a browser are runtime
prerequisites. The project uses MIT; archives also contain the notices for
third-party components. Consumer installation through mise is tracked in
[#107](https://github.com/vmaerten/ghl/issues/107).

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

| File                                | Content                                                 |
| ----------------------------------- | ------------------------------------------------------- |
| `ghl_<version>_darwin_arm64.tar.gz` | `ghl`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`             |
| `checksums.txt`                     | SHA-256 of the archive, with its exact filename         |
| `metadata.json`, `artifacts.json`   | Local GoReleaser build records; retained for validation |

Snapshot versions use `<latest-version>-next-<short-commit>`, or start at
`0.0.0` when no version tag exists. The archive naming pattern is predictable
for download clients and mise. React HTML, JavaScript, CSS and other generated
assets live inside the executable. Toolchains, node_modules and test browsers
are excluded from the archive.

`task release:snapshot` finishes by verifying checksums and the exact archive
contents. It extracts the executable into a temporary directory outside the
checkout and runs it with only Git in PATH. The checks cover `--version --json`,
health metadata, a production diff with untracked files, clean shutdown and
embedded HTML/JavaScript/CSS responses. Guard tests reject corrupt checksums,
wrong commit metadata, unexpected files, symlinks and invalid/stale version tags.
The validator runs natively on macOS ARM64; it does not emulate other targets.

## Version tags and publication

Set `package.json` to the intended version and commit it with the release's
changes. Supported versions are `X.Y.Z` and `X.Y.Z-prerelease`, with a matching
`v`-prefixed tag on that commit. Before pushing a release tag, the same archives
can be built and verified locally from its clean checkout:

```bash
RELEASE_TAG=v0.1.0 mise exec -- task release:build
```

Replace the example with the checked-out tag. The command checks that it matches
`package.json` and points at HEAD. GoReleaser's non-snapshot mode requires a
clean checkout. Both local tasks leave publication disabled in the configuration.

`.github/workflows/go-release.yml` validates pull requests and main-branch pushes
on GitHub's native ARM64 `macos-15` runner. It installs the locked tools, runs
static checks and Go race tests, then builds and verifies a snapshot. Manual
workflow dispatch also creates a snapshot. Version-tag pushes build and verify
the tag's release archives instead. The workflow uploads only the archive and
checksums as a job artifact.

A separate publication job runs only after a successful version-tag build. It
downloads those exact tested files, checks their SHA-256 again and uses
`gh release create --verify-tag` to publish them to this repository. It performs
no checkout or rebuild. Prerelease tags create GitHub prereleases. Existing
releases fail rather than replacing their files; fix a failed publication and
rerun its job. The build job has `contents: read`; the publication job gets
`contents: write` with the repository-scoped `GITHUB_TOKEN`. No external tap,
registry credentials or personal access token is required.

The actions are pinned to commit SHAs. Go, Node, pnpm, Task and GoReleaser are
pinned in `.mise.toml`, with download checksums in `mise.lock`; the mise installer
version is pinned in the workflow. Update these together when upgrading tooling.

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
[GoReleaser templates](https://goreleaser.com/customization/general/templates/),
[GitHub runner targets](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
