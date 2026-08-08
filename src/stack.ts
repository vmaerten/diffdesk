import { readFile } from 'node:fs/promises'

import { gitDirPath, localBranches } from './git.ts'
import type { StackChain, StackLayer } from './types.ts'

/**
 * The chain of branches a stack is made of, as `gh stack` records it.
 *
 * Git stores no parent for a branch, which is why the base has to be guessed at
 * all. The `gh stack` extension does store one: `.git/gh-stack` lists each stack
 * bottom-up, so `trunk → A → B` is written down rather than inferred. Nothing
 * here talks to GitHub — the file is enough, and it is there offline.
 */

/** Only shape this module knows how to read; anything else is treated as absent. */
const SCHEMA_VERSION = 1

/**
 * The file as written, every field optional: it comes from another program, and
 * the guards below are the only thing standing between it and the UI.
 */
interface StackFile {
  schemaVersion?: number
  stacks?: {
    trunk?: { branch?: string }
    branches?: {
      branch?: string
      pullRequest?: { number?: number; url?: string; merged?: boolean }
    }[]
  }[]
}

async function readStackFile(repoPath: string): Promise<StackFile | null> {
  try {
    // `--git-common-dir`: a worktree has its own `.git`, and the stack belongs
    // to the repository rather than to one checkout of it.
    const path = await gitDirPath(repoPath, 'gh-stack', { common: true })
    const parsed: StackFile = JSON.parse(await readFile(path, 'utf8'))
    // A schema we do not know is not a stack we can read: guessing at it would
    // produce a confident, wrong chain.
    return parsed.schemaVersion === SCHEMA_VERSION ? parsed : null
  } catch {
    return null // no gh stack here, or nothing readable — not an error
  }
}

/**
 * The chain `branch` belongs to, or null when it belongs to none.
 *
 * `detectedTrunk` is passed in rather than looked up: the caller has already
 * resolved it, and this module has no business deciding what a trunk is.
 */
export async function readStack(
  repoPath: string,
  branch: string | null,
  detectedTrunk: string | null = null,
): Promise<StackChain | null> {
  if (!branch) return null

  const file = await readStackFile(repoPath)
  const recorded = file?.stacks?.find((stack) =>
    (stack.branches ?? []).some((entry) => entry.branch === branch),
  )
  if (!recorded?.trunk?.branch) return null

  // `gh stack` records a local name (`main`); ghl prefers the remote one, since
  // it is the shared truth. The same branch, when the short names match.
  const shortTrunk = recorded.trunk.branch
  const trunk = detectedTrunk?.endsWith(`/${shortTrunk}`) ? detectedTrunk : shortTrunk

  const live = await localBranches(repoPath)
  const layers: StackLayer[] = []

  // One pass, bottom-up: a layer sits on the nearest one below that is still
  // worth diffing against — the rule `gh stack submit` uses to pick a PR's base.
  // A merged layer's commits are in the trunk already, and a pruned one resolves
  // to nothing at all; either would make the diff above it meaningless.
  let below = trunk
  for (const entry of recorded.branches ?? []) {
    if (!entry.branch) continue
    const pr = entry.pullRequest
    const merged = pr?.merged === true
    const exists = live.has(entry.branch)
    layers.push({
      branch: entry.branch,
      base: below,
      // Both or neither: the front end turns a PR into a link, and a link with
      // no href is one that reloads the page.
      pr: pr?.number !== undefined && pr.url ? { number: pr.number, url: pr.url } : null,
      merged,
      exists,
    })
    if (exists && !merged) below = entry.branch
  }

  // `branch` is why this stack was selected, so it is always one of the layers.
  return { trunk, layers, current: layers.findIndex((layer) => layer.branch === branch) }
}
