# Changelog

## Unreleased

- Keep comments on their original branch across branch switches and restarts,
  including in the comments panel, pending saves and CLI exports.
- Add release build targets for macOS Intel, Linux ARM64 and Linux x86-64.
- Open the default Linux browser through `xdg-open`.
- Validate every archive's checksum, layout and Go OS/architecture settings;
  exercise platform-specific CLI, browser and mise installation gates locally.

## 0.1.0

The `ghl` backend and CLI now run exclusively on Go. React is embedded in the
executable; users need only Git and a browser. The initial release target is
macOS Apple Silicon (ARM64), distributed through GitHub Releases and mise.

- Preserve existing comments, anchors, timestamps and Viewed state directly in
  each checkout's version-1 `.git/ghl/state.json`, with a shared transaction lock.
- Retain text/image review, context expansion, untracked files, base and revision
  selection, stacks, themes, search, shortcuts and comment exports.
- Reuse a shared local daemon and stable `ghl.localhost:7777` repository URLs;
  newer Go executables replace it while preserving registered repositories.
- Use native Task, Air and Vite for build, installation and hot reload.
- Remove the Node backend, CLI and fallback installer. Node and pnpm are only
  needed for development, frontend builds and test drivers.
- Fix search input replacement during delayed opening frames and skip nested
  untracked Git repositories/worktrees rather than aborting the entire review.

Stop an old Node daemon before starting Go on the same port. Read the
[migration guide](./docs/migration.md) for PATH precedence, backups and rollback,
and the [installation guide](./docs/installation.md) for mise commands.
Other platforms and the optional URL without a port remain follow-up work.
