# Reviewing code

Run `ghl` in a Git repository to open its review in the ghl window; running it in another checkout replaces that review. The tree and diff use the same file order; clicking a file or pressing `j` / `k` moves through that order. Use Unified or Split mode, expand unchanged context, and search the whole diff with `Cmd+f`, including files outside the current viewport.

This guide describes `main`. See the [changelog](../CHANGELOG.md) for changes that have not reached a published release.

## Choose a comparison

The default review compares the merge-base of the chosen base and HEAD with the working tree. **Working tree** includes staged and unstaged changes; clear it to review only committed work. **Untracked** includes files Git does not track yet and is off by default, with a count of the excluded files. Symlinks, special files and files over 20 MB stay out, listed in a notice.

Press `t` to review another revision without checking it out. Press `l` to pick one commit: its diff is against its first parent, or the empty tree for a root commit. The base determines which commits are offered, but does not affect a selected commit's patch. A commit that no longer resolves falls back to the whole range with a notice.

Ref and commit views exclude uncommitted and untracked files. Reloading keeps the comparison choices; running `ghl` again with the same comparison leaves the review as it is.

**Ignore whitespace** uses Git's `--ignore-all-space`: spacing-only changes leave the diff, tree and totals, while line breaks and file metadata changes remain. The choice is preserved as `w=1` in the URL. Turn it off to reveal hidden changes.

## Comments

Click the gutter's `+`, or select lines and press `c`. Comments belong to the reviewed branch and survive refreshes, restarts and reinstalls. Switching branches shows that branch's comments; returning restores the earlier ones. Changing the base or displayed commit on the same branch keeps its comments available.

Each comment saves its original code. When those lines change, the comment shows the previous text; restoring the lines clears the stale marker. Comments are never deleted automatically. Editing changes the prose while preserving the original anchor and comparison.

**Comments** opens a side panel listing the branch's comments by file, including files outside the current diff. **View in diff** reveals available lines without clearing Viewed, and the panel stays open beside the diff. Inline cards can be collapsed; their folded state survives reloads.

**Copy** in the title bar (`Shift+Cmd+C`) copies the panel's comments as Markdown, including viewed files and files outside the diff. Individual cards have their own copy button. Exports include paths, line numbers and current code, with original code labelled when current code is unavailable.

`ghl comments` exports the reviewed branch's comments on files in the selected comparison, including untracked files in working-tree reviews. Add `--json` for structured output or a revision argument to review another target. It prints without opening the window; its file scope can be narrower than the panel's.

Older comments recover their branch from the target in their saved comparison. If only commit hashes were recorded, the branch is unknown. Those comments stay in the state file and can be read by explicitly reviewing the recorded target.

## Viewed files

Press `v` or tick a file to mark it Viewed. It folds in place and remains in the tree; clicking its row reveals it again. Changing its displayed diff clears the tick. Viewed is independent across revision ranges, individual commits and whitespace modes, so returning to a scope restores its own ticks.

Right-click a file in the tree or on its header for **Viewed**, **Copy Path** and **Reveal in Finder** on that file; the Review menu does the same for the active file.

Comments and Viewed are stored in `.git/ghl/state.json`, relative to the checkout's Git directory. Linked worktrees have their own state. See the [server guide](../go/README.md#state) for locking, atomic writes and corruption recovery.

## Bases and stacks

`ghl` resolves the base in this order:

1. An explicit `--base`, or a base picked in the window.
2. Its `gh stack` chain.
3. The nearest-parent heuristic, with the trunk winning ties.
4. The detected trunk, using `origin/HEAD` and conventional branch names.

The base is shown, dimmed, before the reviewed branch in the title bar, and its source in the status bar. Click the branch, or press `t`, to review another one. Press `b`, or choose **Go → Choose Base…**, to compare against another base: the choice holds for the review shown and is never written to the repository, so the next `ghl` resolves the base again. **Automatic base** in that picker drops it. Both pickers open on the current choice, so Enter alone changes nothing. When the base already contains the whole branch, the empty review says so and offers the automatic base. The target picker also lists local branches; remote refs remain available through `ghl origin/branch` or a `target` URL parameter. Older releases remembered picked bases as `branch.<name>.ghlBase` in Git configuration; ghl now ignores them.

When the local trunk is strictly behind its fetched `origin` counterpart, the remote ref is preferred. Local trunks that are ahead or diverged are retained. `ghl` does not fetch or change your checkout.

Stack metadata is read from `.git/gh-stack`, including worktree-specific metadata, without calling GitHub. Each layer is compared with the nearest live layer below it; merged or missing layers stay visible while upper layers fall back past them. A stacked branch shows its layer, such as `2/3`, at the start of the title bar's comparison: press `s` or click it to list the stack and pick a layer, or press `[` and `]` to review the layer below or above.

## Images and appearance

Image changes show before/after previews; click to enlarge and Escape to close. PNG, JPEG, GIF, WebP, AVIF, SVG, ICO and BMP are supported. Unavailable or oversized previews show an explanation; the image limit is 20 MiB.

**Settings** (`Cmd+,`) chooses the appearance (System follows macOS, or Light or Dark), a syntax theme for each mode, the code font and size, and the title bar: standard (52 px, the default) or compact (38 px), applied the next time ghl opens. The interface keeps neutral colours; only the code takes the theme's.

For setup and upgrades, see [installation](./installation.md).
