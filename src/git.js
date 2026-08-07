import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Diffs can be large: the biggest real-world PR measured here is ~1 MB of patch,
// but generated files (lockfiles, snapshots) push well past that.
const MAX_BUFFER = 256 * 1024 * 1024

/**
 * Run git inside `repoPath`.
 *
 * Every call goes through `git -C <repoPath>`: the git layer never reads
 * `process.cwd()`. That is what lets a single process serve several repos later
 * on, and it is deliberate — see decision 1 in PLAN.md.
 */
export async function git(repoPath, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  } catch (error) {
    // `git diff` exits 1 when there are differences, which is not a failure.
    if (allowFailure) return error.stdout ?? ''
    const detail = error.stderr?.trim() || error.message
    throw new Error(`git ${args.join(' ')} failed in ${repoPath}: ${detail}`)
  }
}

/** Absolute path of the repository containing `startDir`. */
export async function resolveRepoRoot(startDir) {
  const root = await git(startDir, ['rev-parse', '--show-toplevel'])
  return root.trim()
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(repoPath) {
  const name = (await git(repoPath, ['branch', '--show-current'])).trim()
  return name || null
}

export async function headSha(repoPath) {
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim()
}

export async function revExists(repoPath, rev) {
  const out = await git(repoPath, ['rev-parse', '-q', '--verify', rev], { allowFailure: true })
  return out.trim().length > 0
}

export async function mergeBase(repoPath, a, b) {
  const out = await git(repoPath, ['merge-base', a, b], { allowFailure: true })
  return out.trim() || null
}

/** Number of commits in `from..to`. */
export async function countCommits(repoPath, from, to) {
  const out = await git(repoPath, ['rev-list', '--count', `${from}..${to}`], {
    allowFailure: true,
  })
  return Number.parseInt(out.trim(), 10) || 0
}

/** Local branches and origin refs, excluding symbolic HEADs. */
export async function listRefs(repoPath) {
  const out = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes/origin',
  ])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/HEAD') && line !== 'origin')
}

/**
 * Patch from merge-base(base, HEAD) down to the working tree.
 *
 * `--merge-base` makes git resolve the fork point itself, which is what keeps
 * commits that landed on the base after we branched out of the diff.
 */
export async function diffFromMergeBase(repoPath, base, { contextLines = 3 } = {}) {
  return git(
    repoPath,
    ['diff', '--merge-base', base, `--unified=${contextLines}`, '--no-color', '--no-ext-diff'],
    { allowFailure: true }
  )
}

/**
 * Per-file added/removed line counts, from merge-base to the working tree.
 *
 * Git is the authority here. The parsed patch cannot be used for this:
 * `additionLines` / `deletionLines` on FileDiffMetadata hold each side of the
 * hunk *including context lines*, so summing their lengths overcounts — 388
 * instead of 172 on a real 17-file diff.
 */
export async function numstat(repoPath, base) {
  const out = await git(repoPath, ['diff', '--merge-base', base, '--numstat', '--no-color'], {
    allowFailure: true,
  })

  const files = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [additions, deletions, path] = line.split('\t')
    // Binary files are reported as "-\t-\t<path>".
    const binary = additions === '-'
    files.push({
      path,
      additions: binary ? 0 : Number.parseInt(additions, 10),
      deletions: binary ? 0 : Number.parseInt(deletions, 10),
      binary,
    })
  }
  return files
}

/** Paths that git does not track yet and that .gitignore does not cover. */
export async function untrackedPaths(repoPath) {
  const out = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z'])
  return out.split('\0').filter(Boolean)
}

/**
 * Synthesise a patch for untracked files.
 *
 * They are invisible to `git diff` until staged, and staging them (`git add -N`)
 * would mutate the user's index — unacceptable for a read-only viewer. So each
 * file is diffed against /dev/null out of tree instead.
 */
export async function untrackedPatch(repoPath, paths) {
  const chunks = []
  for (const path of paths) {
    const patch = await git(
      repoPath,
      ['diff', '--no-index', '--no-color', '--', '/dev/null', path],
      { allowFailure: true }
    )
    if (patch.trim()) chunks.push(patch)
  }
  return chunks.join('')
}

/** Default branch as recorded by `origin/HEAD`, e.g. "origin/main". */
export async function originHead(repoPath) {
  const out = await git(repoPath, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  const ref = out.trim()
  return ref ? ref.replace('refs/remotes/', '') : null
}

/**
 * In-progress operation and unresolved conflicts.
 *
 * Real repositories are found mid-merge or mid-rebase — the diff means something
 * different then, and the UI has to say so rather than show a confusing patch.
 */
export async function repoState(repoPath) {
  const gitDir = (await git(repoPath, ['rev-parse', '--git-dir'])).trim()
  const absolute = gitDir.startsWith('/') ? gitDir : `${repoPath}/${gitDir}`

  const { existsSync } = await import('node:fs')
  let operation = null
  if (existsSync(`${absolute}/MERGE_HEAD`)) operation = 'merge'
  else if (existsSync(`${absolute}/rebase-merge`) || existsSync(`${absolute}/rebase-apply`)) {
    operation = 'rebase'
  } else if (existsSync(`${absolute}/CHERRY_PICK_HEAD`)) operation = 'cherry-pick'

  const conflicted = (await git(repoPath, ['diff', '--name-only', '--diff-filter=U'], {
    allowFailure: true,
  }))
    .split('\n')
    .filter(Boolean)

  return { operation, conflicted }
}

export async function readConfig(repoPath, key) {
  const out = await git(repoPath, ['config', '--get', key], { allowFailure: true })
  return out.trim() || null
}

export async function writeConfig(repoPath, key, value) {
  await git(repoPath, ['config', key, value])
}
