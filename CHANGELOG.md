# Changelog

## Unreleased

- Keep comments on their original branch across branch switches and restarts,
  including in the comments panel, pending saves and CLI exports.
  ([#148](https://github.com/vmaerten/ghl/pull/148))
- Use the fetched remote trunk when the local trunk is strictly behind it,
  avoiding unrelated upstream changes in the review. Keep local branches that
  are ahead or diverged, without fetching or changing the checkout.
  ([#83](https://github.com/vmaerten/ghl/pull/83))
- Add an **Ignore whitespace** control that filters whitespace-only changes and
  updates file and line counts. Preserve the choice in the URL, keep separate
  Viewed ticks for each mode, and retain comments on hidden files in the panel.
  ([#147](https://github.com/vmaerten/ghl/pull/147))
- Keep rapid Viewed toggles and resets in order, prevent refreshes from restoring
  older state, and roll back failed saves without replacing newer actions.
  ([80110a1](https://github.com/vmaerten/ghl/commit/80110a185f796adf4d652420af50689447716f43))
- Preserve a comment's first saved code anchor, creation time and original
  comparison when retrying a save, including after code changes.
  ([933b847](https://github.com/vmaerten/ghl/commit/933b847b8452c7ead0d4bce553c27e5d3a293031))
- Wrap review controls on narrow mobile screens so the whitespace control does
  not cause horizontal overflow.
  ([bdd7f75](https://github.com/vmaerten/ghl/commit/bdd7f7505543ca8b56255c3288628fd9e40d22ac))
- Add release build targets for macOS Intel, Linux ARM64 and Linux x86-64.
  ([#144](https://github.com/vmaerten/ghl/pull/144))
- Open the default Linux browser through `xdg-open`.
  ([#143](https://github.com/vmaerten/ghl/pull/143))
- Validate every archive's checksum, layout and Go OS/architecture settings;
  exercise platform-specific CLI, browser and mise installation gates locally.

## 0.1.0

The `ghl` backend and CLI now run exclusively on Go. React is embedded in the
executable; users need only Git and a browser. The initial release target is
macOS Apple Silicon (ARM64), distributed through GitHub Releases and mise.

- Preserve existing comments, anchors, timestamps and Viewed state directly in
  each checkout's version-1 `.git/ghl/state.json`, with a shared transaction lock.
- Review unified or split text diffs, expand unchanged context on demand, and
  preview image changes side by side with click-to-zoom.
- Pick a local base or target branch, review a single commit against its first
  parent, and control working-tree and untracked changes from the page. Keep
  comparison choices in the URL so later CLI invocations do not override them.
- Follow `gh stack` layers, including metadata in linked worktrees, and fall back
  past merged or deleted layers. Use the trunk for branches with no commits of
  their own, while retaining guessed and remembered bases.
- Keep the virtualized tree and diff in the same file order. Fold Viewed files
  in place, reveal them from the tree, and clear their ticks when their changes
  move. Render edited files renamed across languages and search the entire diff,
  including files outside the mounted viewport.
- Write, edit and delete line comments with original code anchors and per-line
  stale markers. Browse comments outside the current diff in the comments panel,
  collapse inline cards, and copy individual comments or the full review with
  code. Export Markdown or JSON through `ghl comments`, with code available as
  soon as a comment is saved.
- Add file-name copy buttons, popular dark and light editor themes, keyboard
  shortcuts and a responsive review layout with a full-width mobile comments
  panel.
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
