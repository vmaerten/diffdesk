import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { FileCounts, GitStatus, RefDetail, RepoOperation, RepoState } from './types.ts'

const execFileAsync = promisify(execFile)

/** What `execFile` rejects with: an Error carrying whatever the process wrote. */
interface ExecFailure extends Error {
  stdout?: string
  stderr?: string
}

const asFailure = (error: unknown): ExecFailure =>
  error instanceof Error ? error : new Error(String(error))

// Real diffs measured here peak around 1 MB of patch; a lockfile alone goes past that.
const MAX_BUFFER = 256 * 1024 * 1024

/**
 * Run git inside `repoPath`.
 *
 * Nothing in this module reads `process.cwd()`, which is what will let one
 * process serve several repositories — decision 1 in PLAN.md.
 */
export async function git(
  repoPath: string,
  args: string[],
  { allowFailure = false }: { allowFailure?: boolean } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      maxBuffer: MAX_BUFFER,
    })
    return stdout
  } catch (cause) {
    const error = asFailure(cause)
    // `git diff` exits 1 when there are differences, which is not a failure.
    if (allowFailure) return error.stdout ?? ''
    const detail = error.stderr?.trim() || error.message
    throw new Error(`git ${args.join(' ')} failed in ${repoPath}: ${detail}`, { cause })
  }
}

/** Absolute path of the repository containing `startDir`. */
export async function resolveRepoRoot(startDir: string): Promise<string> {
  const root = await git(startDir, ['rev-parse', '--show-toplevel'])
  return root.trim()
}

/** Current branch name, or null when HEAD is detached. */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const name = (await git(repoPath, ['branch', '--show-current'])).trim()
  return name || null
}

export async function headSha(repoPath: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim()
}

/** Resolve any revision to a sha. */
export async function revParse(repoPath: string, rev: string): Promise<string | null> {
  const out = await git(repoPath, ['rev-parse', '-q', '--verify', rev], { allowFailure: true })
  return out.trim() || null
}

export async function revExists(repoPath: string, rev: string): Promise<boolean> {
  const out = await git(repoPath, ['rev-parse', '-q', '--verify', rev], { allowFailure: true })
  return out.trim().length > 0
}

export async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  const out = await git(repoPath, ['merge-base', a, b], { allowFailure: true })
  return out.trim() || null
}

/** Number of commits in `from..to`. */
export async function countCommits(repoPath: string, from: string, to: string): Promise<number> {
  const out = await git(repoPath, ['rev-list', '--count', `${from}..${to}`], {
    allowFailure: true,
  })
  return Number.parseInt(out.trim(), 10) || 0
}

/**
 * Candidate bases, most recently touched first.
 *
 * Prebid.js carries 501 refs, so the picker searches rather than lists, and
 * commit date is what puts the branch you actually work on at the top.
 */
export async function listRefDetails(repoPath: string): Promise<RefDetail[]> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(committerdate:relative)%09%(refname)',
    'refs/heads',
    'refs/remotes/origin',
  ])

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, when, fullRef] = line.split('\t')
      return {
        name: name ?? '',
        when: when ?? '',
        remote: fullRef?.startsWith('refs/remotes/') ?? false,
      }
    })
    .filter((ref) => ref.name && !ref.name.endsWith('/HEAD') && ref.name !== 'origin')
}

/** Local branches and origin refs, excluding symbolic HEADs. */
export async function listRefs(repoPath: string): Promise<string[]> {
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
 * Patch from merge-base(base, target) down to target.
 *
 * `--merge-base` keeps commits that landed on the base after we branched out of
 * the diff. Omitting `target` compares against the working tree; passing one
 * reviews a ref without checking it out, and drops uncommitted work along the
 * way since that belongs to the checkout rather than to the ref.
 */
export async function diffFromMergeBase(
  repoPath: string,
  base: string,
  { target, contextLines = 3 }: { target?: string | null; contextLines?: number } = {},
): Promise<string> {
  return git(
    repoPath,
    [
      'diff',
      '--merge-base',
      base,
      ...(target ? [target] : []),
      `--unified=${contextLines}`,
      '--no-color',
      '--no-ext-diff',
    ],
    { allowFailure: true },
  )
}

/**
 * Per-file added/removed line counts, from merge-base to the working tree.
 *
 * Not from the parsed patch: `additionLines` / `deletionLines` hold each side of
 * the hunk *including context*, which reported +388 on a diff git counts as +172.
 */
export async function numstat(
  repoPath: string,
  base: string,
  target?: string | null,
): Promise<FileCounts[]> {
  const out = await git(
    repoPath,
    ['diff', '--merge-base', base, ...(target ? [target] : []), '--numstat', '--no-color'],
    { allowFailure: true },
  )

  const files: FileCounts[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [additions, deletions, path] = line.split('\t')
    if (additions === undefined || deletions === undefined || path === undefined) continue
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

/**
 * Per-file change kind, from merge-base to the target.
 *
 * `--numstat` never says whether a file was added, deleted or renamed, and the
 * tree colours rows by that. `-M` folds an add/delete pair back into a rename.
 */
export async function nameStatus(
  repoPath: string,
  base: string,
  target?: string | null,
): Promise<Map<string, GitStatus>> {
  const out = await git(
    repoPath,
    ['diff', '--merge-base', base, ...(target ? [target] : []), '--name-status', '-M', '-z'],
    { allowFailure: true },
  )

  // -z emits NUL-separated fields, and a rename spends three: status, from, to.
  const fields = out.split('\0').filter(Boolean)
  const kinds: Record<string, GitStatus> = {
    A: 'added',
    D: 'deleted',
    M: 'modified',
    T: 'modified',
  }
  const statuses = new Map<string, GitStatus>()
  for (let i = 0; i < fields.length;) {
    const letter = fields[i++]?.[0] ?? ''
    if (letter === 'R' || letter === 'C') i++ // the source path, gone under that name
    const path = fields[i++]
    if (path === undefined) break
    if (letter === 'R') statuses.set(path, 'renamed')
    else if (letter === 'C') statuses.set(path, 'added')
    else statuses.set(path, kinds[letter] ?? 'modified')
  }
  return statuses
}

/** Paths that git does not track yet and that .gitignore does not cover. */
export async function untrackedPaths(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z'])
  return out.split('\0').filter(Boolean)
}

/**
 * Synthesise a patch for untracked files.
 *
 * They stay invisible to `git diff` until staged, and `git add -N` would mutate
 * the user's index. Diffed against /dev/null out of tree instead.
 */
export async function untrackedPatch(repoPath: string, paths: string[]): Promise<string> {
  const chunks = []
  for (const path of paths) {
    const patch = await git(
      repoPath,
      ['diff', '--no-index', '--no-color', '--', '/dev/null', path],
      { allowFailure: true },
    )
    if (patch.trim()) chunks.push(patch)
  }
  return chunks.join('')
}

/** Default branch as recorded by `origin/HEAD`, e.g. "origin/main". */
export async function originHead(repoPath: string): Promise<string | null> {
  const out = await git(repoPath, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  })
  const ref = out.trim()
  return ref ? ref.replace('refs/remotes/', '') : null
}

/**
 * In-progress operation and unresolved conflicts.
 *
 * A repository caught mid-merge or mid-rebase produces a diff that means
 * something else, and the UI has to say so rather than show it silently.
 */
export async function repoState(repoPath: string): Promise<RepoState> {
  const gitDir = (await git(repoPath, ['rev-parse', '--git-dir'])).trim()
  const absolute = gitDir.startsWith('/') ? gitDir : `${repoPath}/${gitDir}`

  const { existsSync } = await import('node:fs')
  let operation: RepoOperation | null = null
  if (existsSync(`${absolute}/MERGE_HEAD`)) operation = 'merge'
  else if (existsSync(`${absolute}/rebase-merge`) || existsSync(`${absolute}/rebase-apply`)) {
    operation = 'rebase'
  } else if (existsSync(`${absolute}/CHERRY_PICK_HEAD`)) operation = 'cherry-pick'

  const conflicted = (
    await git(repoPath, ['diff', '--name-only', '--diff-filter=U'], {
      allowFailure: true,
    })
  )
    .split('\n')
    .filter(Boolean)

  return { operation, conflicted }
}

export async function readConfig(repoPath: string, key: string): Promise<string | null> {
  const out = await git(repoPath, ['config', '--get', key], { allowFailure: true })
  return out.trim() || null
}

export async function writeConfig(repoPath: string, key: string, value: string): Promise<void> {
  await git(repoPath, ['config', key, value])
}
