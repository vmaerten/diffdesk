---
title: Reviewing code
description: Comparisons, comments, Viewed files, bases and stacks, pull requests, images, Markdown and appearance.
---

Run `diffdesk` in a Git repository to open its review in the Diffdesk window; running it in another checkout replaces that review. The tree and diff use the same file order; clicking a file or pressing `j` / `k` moves through that order. Use Unified or Split mode, wrap long lines with **View → Wrap Lines** (`Option+z`, also in Settings), expand unchanged context, and search the whole diff with `Cmd+f`, including files outside the current viewport.

`Cmd+K` opens a command palette that finds a command by name and shows its shortcut, with a check on those that show a state, such as Split or Ignore Whitespace. `Cmd+P` lists the review's files with their folder, line counts and status, to jump to one by name; the palette's Commands and Files tabs switch between the two.

This guide describes `main`. See the [changelog](https://github.com/vmaerten/diffdesk/blob/main/CHANGELOG.md) for changes that have not reached a published release.

## Choose a comparison

The default review compares the merge-base of the chosen base and HEAD with the working tree. **Working tree** includes staged and unstaged changes; clear it to review only committed work. **Untracked** includes files Git does not track yet and is off by default, with a count of the excluded files. Symlinks, special files and files over 20 MB stay out, listed in a notice.

Press `t` to review another revision without checking it out. Press `l` to pick one commit: its diff is against its first parent, or the empty tree for a root commit. The base determines which commits are offered, but does not affect a selected commit's patch. A commit that no longer resolves falls back to the whole range with a notice.

Ref and commit views exclude uncommitted and untracked files. Reloading keeps the comparison choices; running `diffdesk` again with the same comparison leaves the review as it is.

**Ignore whitespace** uses Git's `--ignore-all-space`: spacing-only changes leave the diff, tree and totals, while line breaks and file metadata changes remain. The choice is preserved as `w=1` in the URL. Turn it off to reveal hidden changes.

## Comments

Click the gutter's `+`, or select lines and press `c`. A selection that runs from added or unchanged lines into removed ones, or across the columns of the split view, comments on the lines of the new file it covers. Comments belong to the reviewed branch and survive refreshes, restarts and reinstalls. Switching branches shows that branch's comments; returning restores the earlier ones. Changing the base or displayed commit on the same branch keeps its comments available.

Each comment saves its original code. When those lines change, the comment shows the previous text; restoring the lines clears the stale marker. Comments are never deleted automatically. Editing changes the prose while preserving the original anchor and comparison.

**Comments** opens a side panel listing the branch's comments by file, including files outside the current diff. **View in diff** reveals available lines without clearing Viewed, and the panel stays open beside the diff. Inline cards can be collapsed; their folded state survives reloads.

A remark about a whole file goes through the comment button in its header, **Comment on File…** in its context menu or the Review menu; one about the whole review through the panel's `+` or **Review → Comment on Review…**. Both are written in the panel, where review comments come first, and are copied, exported and resolved like the others: the export names them `path (whole file)` and `(whole review)`, and `--json` gives them lines `0`, the review's with an empty path.

**Copy** in the title bar (`Shift+Cmd+C`) copies the panel's comments, including viewed files and files outside the diff. Individual cards have their own copy button. The text is sized for an agent, which reads the code in the file it edits: each comment gives its ID, `path:lines` and body, and quotes only the lines the file no longer has, under `code:` for lines the change removed and `was:` for lines changed since the remark or outside the comparison.

**Resolve** on a card closes the comment without deleting it: it leaves the diff, the panel, the count and Copy, and stays in the state file. `diffdesk comments reopen <id>` brings it back, and `diffdesk comments resolve <id>` closes one from the terminal; any unique prefix of 4 or more characters of the ID works.

`diffdesk comments` exports the reviewed branch's open comments on files in the selected comparison, including untracked files in working-tree reviews. It prints the same text as Copy; add `--code` to quote every comment's current lines, `--json` for structured output, `--all` to include resolved comments, or a revision argument to review another target. It prints without opening the window; its file scope can be narrower than the panel's.

Older comments recover their branch from the target in their saved comparison. If only commit hashes were recorded, the branch is unknown. Those comments stay in the state file and can be read by explicitly reviewing the recorded target.

## Walkthrough

A walkthrough is a tour of the change, written by the agent that made it: a few stops, each with a title, a sentence and the hunks that carry it, in the order that helps the review. Ask the agent to run `diffdesk walkthrough guide`, which tells it how to write one; it lists the hunk IDs with `diffdesk walkthrough hunks`, `path#n` for the n-th hunk of a file, and saves the tour with `diffdesk walkthrough set <file>`, which rejects an unknown or repeated hunk and prints what to fix. `diffdesk walkthrough show` prints the reviewed branch's walkthrough, `clear` deletes it.

**Walkthrough** in the side panel, beside **Comments**, reads it: chapters and stops, the current stop with its prose and hunks. Choosing a stop, or `n` and `p`, scrolls the diff to its first hunk and marks each of its hunks with a **Stop N of M** card; the diff itself stays whole, and comments work as anywhere else. Leaving a stop for the next one ticks it read, and the progress is kept with the walkthrough until a new one replaces it. **View → Walkthrough** and the command palette open the panel; a walkthrough saved while the window is open shows after a refresh (`r`).

Diffdesk can also have an agent write one, in beta: choose Claude Code or Codex under **Settings → Walkthrough**, then use **Generate Walkthrough…** in the panel or the command palette. The sheet says what is sent: the diff goes to that agent's provider, through its own CLI found in your login shell and signed in as you, and the agent gets no tool that writes. The walkthrough opens once saved, replacing the branch's previous one; **Cancel** stops the agent, and a failure keeps its output, with **Try Again**.

A walkthrough belongs to the reviewed branch and survives later changes: a hunk that moved is found by its content, and a stop whose hunks are gone says so. Once half the hunks are gone, the walkthrough is marked stale and is better written again.

## Viewed files

Press `v` or tick a file to mark it Viewed. It folds in place and remains in the tree; clicking its row reveals it again. Changing its displayed diff clears the tick. Viewed is independent across revision ranges, individual commits and whitespace modes, so returning to a scope restores its own ticks.

Right-click a file in the tree or on its header for **Viewed**, **Copy Path** and **Reveal in Finder** on that file; the Review menu does the same for the active file.

Comments and Viewed are stored in `.git/ghl/state.json`, relative to the checkout's Git directory. Linked worktrees have their own state. See the [server guide](https://github.com/vmaerten/diffdesk/blob/main/go/README.md#state) for locking, atomic writes and corruption recovery.

## Bases and stacks

`diffdesk` resolves the base in this order:

1. An explicit `--base`, or a base picked in the window.
2. Its `gh stack` chain.
3. The nearest-parent heuristic, with the trunk winning ties.
4. The detected trunk, using `origin/HEAD` and conventional branch names.

The base is shown, dimmed, before the reviewed branch in the title bar, and its source in the status bar. Click the branch, or press `t`, to review another one. Press `b`, or choose **Go → Choose Base…**, to compare against another base: the choice holds for the review shown and is never written to the repository, so the next `diffdesk` resolves the base again. **Automatic base** in that picker drops it. Both pickers open on the current choice, so Enter alone changes nothing. When the base already contains the whole branch, the empty review says so and offers the automatic base. The target picker also lists local branches; remote refs remain available through `diffdesk origin/branch` or a `target` URL parameter. Older releases remembered picked bases as `branch.<name>.ghlBase` in Git configuration; Diffdesk now ignores them.

When the local trunk is strictly behind its fetched `origin` counterpart, the remote ref is preferred. Local trunks that are ahead or diverged are retained. `diffdesk` does not fetch or change your checkout.

Stack metadata is read from `.git/gh-stack`, including worktree-specific metadata, without calling GitHub. Each layer is compared with the nearest live layer below it; merged or missing layers stay visible while upper layers fall back past them. A stacked branch shows its layer, such as `2/3`, at the start of the title bar's comparison: press `s` or click it to list the stack and pick a layer, or press `[` and `]` to review the layer below or above.

## Code intelligence (beta)

**Settings › Intelligence** turns on answers from the language servers installed on your Mac. Hold `Cmd` over a symbol for its type and documentation, and `Cmd`-click it to go to its definition: the diff scrolls to the definition when it shows those lines, and `Cmd+[` comes back; otherwise the card shows the definition's code. Nothing happens without `Cmd`.

Added and unchanged lines work in working-tree, branch and commit reviews. For a committed revision, Diffdesk automatically prepares an isolated copy of the exact commit displayed, so choosing another branch leaves your current checkout and its edits intact. Copies are reused for the session and removed when the app stops. Deleted lines stay plain. A working-tree file changed since the review loaded asks for a refresh (`r`).

Diffdesk reuses language-server executables installed in your checkout or on PATH. It does not install project dependencies in the isolated copy, so external imports may be unresolved. **Check IntelliSense Status…** in the command palette shows the analyzed revision, the copy's location and each server's state.

**References** on the card opens a **Symbol** tab beside **Comments**: the symbol's definition and signature, then its references in the repository by file, in the tree's order. A reference the diff shows is marked `in diff` and opens there; the others show their line. **In this diff only** hides the rest. Settings › Intelligence › **Symbol panel** turns the tab and the action off.

Settings list each language's server for the review shown, with where it comes from, unless you pick one:

| Language | Server |
| --- | --- |
| TypeScript and JavaScript | `tsrs` from the checkout or PATH, then the checkout's TypeScript 7 `tsc`, then `typescript-language-server` on PATH |
| Python | the checkout's `.venv` `basedpyright` or `pyright`, then `basedpyright`, `pyright` or `ty` on PATH |
| Go | `gopls` |
| Terraform | `terraform-ls` |
| Helm | `helm_ls`, for the files of a chart's `templates` folder |
| Rust | `rust-analyzer` |

Highlighters often merge several names into one token, such as a Helm template's `.Values.replicaCount`: Diffdesk looks up, and underlines, the name under the pointer. The servers run on the reviewed code, as your editor would; Diffdesk finds them through your login shell, so tools installed with Homebrew or mise work even when the app was opened from the Finder. A server starts on the first lookup and stops after 10 minutes without one. The status bar shows the diff's servers and whether they are starting, indexing or failed.

## Pull requests

When the reviewed branch has a pull request on GitHub, its number shows in the title bar, with the icon and colour of its state: open, draft, merged or closed. Then come its checks — GitHub Actions runs and commit statuses: a cross with the number failing, a dot with how many are done while they run, a tick once all pass. An arrow counts the local commits GitHub does not have yet, and a warning sign says the pull request conflicts with its base. Click it for the title, the reviews, the merge status, what is not pushed, the checks with their logs, failing ones first, and a link to GitHub. Checks ran on GitHub's head: the popover says so when you have local changes. While one runs, the pull request refreshes every 15 seconds as long as the window is in front.

Diffdesk asks the [GitHub CLI](https://cli.github.com/): install it and run `gh auth login` once. Without it, or signed out, Diffdesk works as before, without the network. The pull request is the one whose head is the reviewed branch, or the branch it pushes to; an open one wins over closed ones. It refreshes with the review (`r`) and when you come back to the window. **Settings › GitHub** says which account gh uses, turns pull requests off, or shows them in the status bar instead of the title bar: the same items, in words, with the popover opening above.

## Images, Markdown and appearance

Image changes show before/after previews; click to enlarge and Escape to close. PNG, JPEG, GIF, WebP, AVIF, SVG, ICO and BMP are supported. Unavailable or oversized previews show an explanation; the image limit is 20 MiB.

A Markdown file's header switches between **Source** and **Rendered**. Rendered shows the reviewed version with headings, lists, tables and code blocks, and marks the blocks that hold added lines; a deleted file shows its previous version. Raw HTML and images are left out, and only web links open, in the browser. Comments stay on source lines: viewing one, or a search match, switches the file back to Source.

**Settings** (`Cmd+,`) opens in a window of its own, beside the review, which follows each change as you make it. **Appearance** chooses System (follows macOS), Light or Dark and a syntax theme for each mode, **Code** the code font and size, **Window** the title bar: standard (52 px, the default) or compact (38 px), applied the next time Diffdesk opens, and **GitHub** whether and where to show pull requests. The interface keeps neutral colours; only the code takes the theme's.

For setup and upgrades, see [installation](../installation/).
