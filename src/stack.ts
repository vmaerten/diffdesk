import { readFile } from 'node:fs/promises'

import { git, revExists } from './git.ts'
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

interface RecordedPullRequest {
  number?: number
  url?: string
  merged?: boolean
}

interface RecordedBranch {
  branch?: string
  pullRequest?: RecordedPullRequest
}

interface RecordedStack {
  trunk?: { branch?: string }
  branches?: RecordedBranch[]
}

interface StackFile {
  schemaVersion?: number
  stacks?: RecordedStack[]
}

/**
 * `--git-common-dir` rather than `--git-dir`: a worktree has its own `.git`, and
 * the stack belongs to the repository, not to one checkout of it.
 */
async function stackFilePath(repoPath: string): Promise<string> {
  const dir = (await git(repoPath, ['rev-parse', '--git-common-dir'])).trim()
  const absolute = dir.startsWith('/') ? dir : `${repoPath}/${dir}`
  return `${absolute}/gh-stack`
}

async function readStackFile(repoPath: string): Promise<StackFile | null> {
  try {
    const parsed: StackFile = JSON.parse(await readFile(await stackFilePath(repoPath), 'utf8'))
    // A schema we do not know is not a stack we can read: guessing at it would
    // produce a confident, wrong chain.
    return parsed.schemaVersion === SCHEMA_VERSION ? parsed : null
  } catch {
    return null // no gh stack here, or nothing readable — not an error
  }
}

/**
 * The trunk to diff the bottom layer against.
 *
 * `gh stack` records a local name (`main`); ghl prefers the remote one, since it
 * is the shared truth. They are the same branch when the short names match.
 */
function preferredTrunk(recorded: string, detected: string | null): string {
  if (!detected) return recorded
  return detected === recorded || detected.endsWith(`/${recorded}`) ? detected : recorded
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
  if (!file) return null

  const stacks = file.stacks ?? []
  const recorded = stacks.find((stack) =>
    (stack.branches ?? []).some((entry) => entry.branch === branch),
  )
  if (!recorded?.trunk?.branch) return null

  const trunk = preferredTrunk(recorded.trunk.branch, detectedTrunk)
  const layers: StackLayer[] = []

  for (const entry of recorded.branches ?? []) {
    if (!entry.branch) continue
    const pr = entry.pullRequest
    const merged = pr?.merged === true
    layers.push({
      branch: entry.branch,
      // Filled below: it depends on which layers underneath are still live.
      base: trunk,
      // Both or neither: the front end turns a PR into a link, and a link with
      // no href is one that reloads the page.
      pr: pr?.number !== undefined && pr.url ? { number: pr.number, url: pr.url, merged } : null,
      merged,
      exists: await revExists(repoPath, entry.branch),
    })
  }
  if (layers.length === 0) return null

  // Each layer sits on the nearest one below that is still worth diffing
  // against — the rule `gh stack submit` uses to pick a PR's base. A merged
  // layer's commits are in the trunk already, and a pruned one resolves to
  // nothing at all; either would make the diff below it meaningless.
  let below = trunk
  for (const layer of layers) {
    layer.base = below
    if (layer.exists && !layer.merged) below = layer.branch
  }

  return { trunk, layers, current: layers.findIndex((layer) => layer.branch === branch) }
}
