# ghl

Review the PR you are about to open, without opening it.

A local git diff viewer with a GitHub-like UI, for the moment when the change is written
but pushing it just to look at it is not worth the trip.

**Status:** steps 1–3 of [PLAN.md](./PLAN.md) — CLI, server and diff rendering.
File tree, keyboard navigation and the viewed state are next.

## Usage

```bash
npm install && npm run build   # once: builds the UI into web-dist/

ghl                 # open the current repo's virtual PR in the browser
ghl --print         # summary on stdout, no server
ghl --base main     # compare against an explicit revision
ghl --untracked     # include untracked files in the diff
```

To iterate on the UI, run `ghl --no-open --port 7777` in a repository and `npm run dev`
here: Vite serves the front end on :5180 and forwards data calls to it.

`ghl` with no argument shows **everything that is not in the base**, committed or not:
the diff from `merge-base(base, HEAD)` down to the working tree.

## How the base is chosen

Git records no parent for a branch, so `ghl` resolves one, most trustworthy source first:

1. `branch.<name>.ghlBase` in `.git/config` — your remembered choice
2. the stacked-branch heuristic — the ref whose merge-base is closest to HEAD, the trunk
   winning ties (a sibling branch is not a parent)
3. `origin/HEAD`
4. the first existing of `origin/main`, `origin/master`, `origin/develop`, then their local
   counterparts

The chosen base and how it was obtained are always reported: a wrong base silently produces
a misleading diff.

To pin a base for the current branch:

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"base":"origin/main"}' localhost:<port>/r/<repoId>/api/base
```

## Layout

```
bin/ghl.js       CLI — the only place that reads the current directory
src/git.js       git layer, every call through `git -C <repoPath>`
src/revision.js  base resolution and patch construction
src/server.js    HTTP server, routes namespaced by repo
```
