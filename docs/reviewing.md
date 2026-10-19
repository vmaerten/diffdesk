# Reviewing code

Run `ghl` in a Git repository to open its review. The tree and diff use the same
file order; clicking a file or pressing `j` / `k` moves through that order.
Use Unified or Split mode, expand unchanged context, and search the whole diff
with `Ctrl+f` / `Cmd+f`, including files outside the current viewport.

This guide describes `main`. See the [changelog](../CHANGELOG.md) for changes
that have not reached a published release.

## Choose a comparison

The default review compares the merge-base of the chosen base and HEAD with the
working tree. **Working tree** includes staged and unstaged changes; clear it to
review only committed work. **Untracked** includes files Git does not track yet
and is off by default, with a count of the excluded files.

Press `t` to review another revision without checking it out. Press `l` to pick
one commit: its diff is against its first parent, or the empty tree for a root
commit. The base determines which commits are offered, but does not affect a
selected commit's patch. A commit that no longer resolves falls back to the
whole range with a notice.

Ref and commit views exclude uncommitted and untracked files. Comparison choices
live in the URL, so reloading keeps them and another CLI invocation does not
override an open tab.

**Ignore whitespace** uses Git's `--ignore-all-space`: spacing-only changes leave
the diff, tree and totals, while line breaks and file metadata changes remain.
The choice is preserved as `w=1` in the URL. Turn it off to reveal hidden changes.

## Comments

Click the gutter's `+`, or select lines and press `c`. Comments belong to the
reviewed branch and survive refreshes, restarts and reinstalls. Switching branches
shows that branch's comments; returning restores the earlier ones. Changing the
base or displayed commit on the same branch keeps its comments available.

Each comment saves its original code. When those lines change, the comment shows
the previous text; restoring the lines clears the stale marker. Comments are
never deleted automatically. Editing changes the prose while preserving the
original anchor and comparison.

**Comments** lists the branch's comments by file, including files outside the
current diff. **View in diff** reveals available lines without clearing Viewed.
Inline cards can be collapsed; their folded state survives reloads in the same
tab. On mobile, the panel fills the screen.

**Copy all** copies the panel's comments as Markdown, including viewed files and
files outside the diff. Individual cards have their own copy button. Exports
include paths, line numbers and current code, with original code labelled when
current code is unavailable.

`ghl comments` exports the reviewed branch's comments on files in the selected
comparison, including untracked files in working-tree reviews. Add `--json` for
structured output or a revision argument to review another target. The CLI
needs no running server; its file scope can be narrower than the panel's.

Older comments recover their branch from the target in their saved comparison.
If only commit hashes were recorded, the branch is unknown. Those comments stay
in the state file and can be read by explicitly reviewing the recorded target.

## Viewed files

Press `v` or tick a file to mark it Viewed. It folds in place and remains in the
tree; clicking its row reveals it again. Changing its displayed diff clears the
tick. Viewed is independent across revision ranges, individual commits and
whitespace modes, so returning to a scope restores its own ticks.

Comments and Viewed are stored in `.git/ghl/state.json`, relative to the
checkout's Git directory. Linked worktrees have their own state. See
[state compatibility](../go/README.md#state-compatibility-and-transition) for
backups, prototype imports and corruption recovery.

## Bases and stacks

`ghl` resolves the base in this order:

1. An explicit `--base` or URL choice.
2. The reviewed branch's remembered `branch.<name>.ghlBase` in Git configuration.
3. Its `gh stack` chain.
4. The nearest-parent heuristic, with the trunk winning ties.
5. The detected trunk, using `origin/HEAD` and conventional branch names.

The base and its source are shown in the header. Press `b` to pick a local branch
and remember that choice. The target picker also lists local branches; remote
refs remain available through `ghl origin/branch` or a `target` URL parameter.

When the local trunk is strictly behind its fetched `origin` counterpart, the
remote ref is preferred. Local trunks that are ahead or diverged are retained.
`ghl` does not fetch or change your checkout.

Stack metadata is read from `.git/gh-stack`, including worktree-specific metadata,
without calling GitHub. Each layer is compared with the nearest live layer below
it; merged or missing layers stay visible while upper layers fall back past them.
Click a layer to review it.

## Images and appearance

Image changes show before/after previews; click to enlarge and Escape to close.
PNG, JPEG, GIF, WebP, AVIF, SVG, ICO and BMP are supported. Unavailable or oversized
previews show an explanation; the image limit is 20 MiB.

The theme picker updates the interface and syntax highlighting together and
remembers the choice in this browser. On narrow screens, **Files** opens the
tree over the diff and closes after selection; the diff uses unified mode.

For daemon lifetime, ports and stable URLs, see the
[runtime guide](../go/README.md#shared-runtime-lifecycle). For setup and upgrades,
see [installation](./installation.md).
