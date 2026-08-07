import {
  countCommits,
  currentBranch,
  diffFromMergeBase,
  listRefs,
  mergeBase,
  numstat,
  originHead,
  readConfig,
  revExists,
  revParse,
  untrackedPaths,
  untrackedPatch,
  writeConfig,
} from './git.js'

// Remote refs first — they are the shared truth. Local names come last, for
// repositories with no remote at all (mrev and fuel-tracker are two).
const TRUNK_FALLBACKS = [
  'origin/main',
  'origin/master',
  'origin/develop',
  'main',
  'master',
  'develop',
]

const baseConfigKey = (branch) => `branch.${branch}.ghlBase`

/**
 * The repository's trunk.
 *
 * `origin/HEAD` is authoritative but missing on 22 of the 86 repos measured
 * here, hence the fallback list. Hardcoding "main" would break on 29 of them.
 */
export async function detectTrunk(repoPath) {
  const fromOriginHead = await originHead(repoPath)
  if (fromOriginHead && (await revExists(repoPath, fromOriginHead))) return fromOriginHead

  for (const candidate of TRUNK_FALLBACKS) {
    if (await revExists(repoPath, candidate)) return candidate
  }
  return null
}

/**
 * Guess which ref a branch was created from.
 *
 * Git records no parent for a branch, so we look for the ref whose merge-base
 * sits closest to HEAD.
 *
 * The trunk wins ties, and that rule is load-bearing: two sibling branches cut
 * from the same commit produce the exact same distance as the trunk, and a
 * sibling is not a parent. Without the rule, `adessi/pren-322-input` resolves to
 * an unrelated branch that happens to share its fork point.
 */
export async function guessParent(repoPath, head, trunk) {
  // Resolve the ref we are analysing, NOT HEAD: when reviewing someone else's
  // branch the checkout is irrelevant, and using HEAD here silently guessed the
  // base of the wrong branch.
  const headRev = await revParse(repoPath, head)
  if (!headRev) return null
  const refs = await listRefs(repoPath)

  let best = null
  let bestDistance = Number.POSITIVE_INFINITY
  let trunkDistance = null

  for (const ref of refs) {
    if (ref === head) continue

    const base = await mergeBase(repoPath, headRev, ref)
    if (!base) continue
    // The ref descends from HEAD, so it cannot be its parent.
    if (base === headRev) continue

    const distance = await countCommits(repoPath, base, headRev)
    if (distance === 0) continue

    if (ref === trunk) trunkDistance = distance
    if (distance < bestDistance) {
      bestDistance = distance
      best = ref
    }
  }

  if (trunkDistance !== null && bestDistance >= trunkDistance) {
    return { ref: trunk, distance: trunkDistance, reason: 'trunk' }
  }
  if (!best) return null
  return { ref: best, distance: bestDistance, reason: 'stacked-branch' }
}

/**
 * Resolve the base to diff against, most trustworthy source first.
 *
 * The result carries how it was obtained: the UI must show it, because a wrong
 * base silently produces a misleading diff.
 */
export async function resolveBase(repoPath, { override, target } = {}) {
  // The base is guessed for whatever we are reviewing: reviewing someone else's
  // branch must not inherit the base of the branch we happen to sit on.
  const branch = target ?? (await currentBranch(repoPath))
  const trunk = await detectTrunk(repoPath)

  if (override) {
    if (!(await revExists(repoPath, override))) {
      throw new Error(`base "${override}" does not resolve to a revision`)
    }
    return { ref: override, source: 'override', branch, trunk }
  }

  if (branch) {
    const remembered = await readConfig(repoPath, baseConfigKey(branch))
    if (remembered && (await revExists(repoPath, remembered))) {
      return { ref: remembered, source: 'remembered', branch, trunk }
    }
  }

  // On the trunk itself there is nothing to guess.
  const onTrunk = trunk && (branch === trunk.replace('origin/', '') || branch === trunk)
  if (!onTrunk && branch) {
    const guessed = await guessParent(repoPath, branch, trunk)
    if (guessed && guessed.reason === 'stacked-branch') {
      return { ref: guessed.ref, source: 'guessed', branch, trunk, distance: guessed.distance }
    }
  }

  if (trunk) return { ref: trunk, source: 'trunk', branch, trunk }
  throw new Error('no base found: set one with --base, or define origin/HEAD')
}

/** Persist a base choice so it is never guessed again for this branch. */
export async function rememberBase(repoPath, branch, base) {
  if (!branch) throw new Error('cannot remember a base while HEAD is detached')
  await writeConfig(repoPath, baseConfigKey(branch), base)
}

/**
 * The "virtual PR": everything not in the base, committed or not.
 *
 * Tracked changes come from a single `git diff --merge-base`.
 *
 * Untracked files are listed but kept OUT of the patch by default. Measured on
 * prebid-server-proxy: 2 files actually modified against 446 untracked ones
 * (bench/, infra/dns/, scratch/…) that are real but not ignored — folding them
 * in drowns the diff. Callers opt in with `includeUntracked`.
 */
export async function buildPatch(repoPath, base, { target, includeUntracked = false } = {}) {
  const tracked = await diffFromMergeBase(repoPath, base, { target })
  const files = await numstat(repoPath, base, target)

  // Uncommitted work belongs to the working tree, so it is meaningless when
  // reviewing some other ref.
  const paths = target ? [] : await untrackedPaths(repoPath)

  const totals = files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 }
  )

  if (!includeUntracked || paths.length === 0) {
    return { patch: tracked, untracked: paths, untrackedIncluded: false, files, totals }
  }

  const extra = await untrackedPatch(repoPath, paths)
  return { patch: tracked + extra, untracked: paths, untrackedIncluded: true, files, totals }
}
