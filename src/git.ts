import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import type {
  CommitDetail,
  FileCounts,
  GitStatus,
  RefDetail,
  RepoOperation,
  RepoState,
} from './types.ts'

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

/**
 * A path inside the repository's `.git`.
 *
 * `rev-parse` answers relatively whenever it can, so its result has to be
 * resolved against the repository rather than used as is. `common` asks for the
 * directory shared by every worktree — where anything belonging to the
 * repository, rather than to one checkout of it, lives.
 */
export async function gitDirPath(
  repoPath: string,
  relative: string,
  { common = false }: { common?: boolean } = {},
): Promise<string> {
  const dir = await git(repoPath, ['rev-parse', common ? '--git-common-dir' : '--git-dir'])
  return resolve(repoPath, dir.trim(), relative)
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
 * Local branches only: `origin/<name>` is the same branch under another name,
 * and listing both doubled every entry. Sorted by commit date so the branch you
 * actually work on sits on top before you type anything.
 */
export async function listRefDetails(repoPath: string): Promise<RefDetail[]> {
  const out = await git(repoPath, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)%09%(committerdate:relative)',
    'refs/heads',
  ])

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, when] = line.split('\t')
      return { name: name ?? '', when: when ?? '' }
    })
    .filter((ref) => ref.name)
}

/** Names of the local branches, in one call. */
export async function localBranches(repoPath: string): Promise<Set<string>> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return new Set(
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
}

/**
 * The empty tree, as `git hash-object -t tree /dev/null` reports it.
 *
 * What a root commit is diffed against, since it has no parent. The forms that
 * look shorter do not survive one: `git diff <root>^!` degrades to
 * `git diff <root>`, which compares that commit to the *working tree* — a
 * plausible-looking answer to a question nobody asked.
 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** What a commit's own diff starts from: its first parent, or nothing. */
export async function commitParent(repoPath: string, sha: string): Promise<string> {
  // The first parent explicitly: a merge is read against the branch it was
  // merged into, and `git diff-tree -m` would emit one record per parent.
  return (await revParse(repoPath, `${sha}^1`)) ?? EMPTY_TREE
}

const COMMIT_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar%x1f%P'

/** ` 8 files changed, 149 insertions(+), 65 deletions(-)`, any part optional. */
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

/**
 * `COMMIT_FORMAT` records, each optionally followed by its `--shortstat` line.
 *
 * Scanned line by line rather than split on the blank line between records:
 * git emits no stat line at all for a merge, so the record is short, not
 * absent, and anything counting lines per commit drifts from there on.
 */
function parseCommits(out: string): CommitDetail[] {
  const commits: CommitDetail[] = []
  for (const line of out.split('\n')) {
    if (line.includes('\x1f')) {
      const [sha, short, subject, author, when, parents] = line.split('\x1f')
      if (!sha) continue
      commits.push({
        sha,
        short: short ?? sha.slice(0, 7),
        subject: subject ?? '',
        author: author ?? '',
        when: when ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        additions: null,
        deletions: null,
        files: null,
      })
      continue
    }
    const stat = SHORTSTAT.exec(line)
    const commit = commits.at(-1)
    if (!stat || !commit) continue
    commit.files = Number.parseInt(stat[1] ?? '0', 10)
    commit.additions = Number.parseInt(stat[2] ?? '0', 10)
    commit.deletions = Number.parseInt(stat[3] ?? '0', 10)
  }
  return commits
}

/**
 * The commits of a review's range, newest first.
 *
 * `from..to` already means "reachable from `to`, not from `from`", which is the
 * merge-base range without paying for the merge-base. One process carries the
 * subjects, the parents and the counts: a call per commit would be as many git
 * processes as the branch has commits, for a list nobody may open.
 */
export async function listCommits(
  repoPath: string,
  from: string,
  to: string,
): Promise<CommitDetail[]> {
  const out = await git(
    repoPath,
    ['log', COMMIT_FORMAT, '--shortstat', '--no-color', `${from}..${to}`, '--'],
    { allowFailure: true },
  )
  return parseCommits(out)
}

/** One commit, or null when the sha no longer resolves. */
export async function commitDetail(repoPath: string, sha: string): Promise<CommitDetail | null> {
  const out = await git(
    repoPath,
    ['log', '-1', COMMIT_FORMAT, '--shortstat', '--no-color', sha, '--'],
    { allowFailure: true },
  )
  return parseCommits(out)[0] ?? null
}

/**
 * What a diff spans.
 *
 * `merge-base` is the review's range: from where the branch left the base down
 * to the target, so commits that landed on the base afterwards stay out.
 * Omitting `target` there compares against the working tree; passing one reviews
 * a ref without checking it out, and drops uncommitted work along the way since
 * that belongs to the checkout rather than to the ref.
 *
 * `two-point` is one commit against its parent, where no base is involved.
 */
export type DiffRange =
  | { kind: 'merge-base'; base: string; target?: string | null }
  | { kind: 'two-point'; from: string; to: string }

const revisionArgs = (range: DiffRange): string[] =>
  range.kind === 'merge-base'
    ? ['--merge-base', range.base, ...(range.target ? [range.target] : [])]
    : [range.from, range.to]

/** The patch itself, over whichever range. */
export async function diffPatch(
  repoPath: string,
  range: DiffRange,
  { contextLines = 3 }: { contextLines?: number } = {},
): Promise<string> {
  return git(
    repoPath,
    ['diff', ...revisionArgs(range), `--unified=${contextLines}`, '--no-color', '--no-ext-diff'],
    { allowFailure: true },
  )
}

/**
 * Per-file added/removed line counts.
 *
 * Not from the parsed patch: `additionLines` / `deletionLines` hold each side of
 * the hunk *including context*, which reported +388 on a diff git counts as +172.
 *
 * `-z` is not only about quoting. Without it a rename is one line reading
 * `0\t0\told => new`, and that arrow is a path no other source agrees with — not
 * the patch, not `--name-status`. With it, the record ends after the counts and
 * the two paths follow as their own fields.
 */
export async function numstat(repoPath: string, range: DiffRange): Promise<FileCounts[]> {
  const out = await git(
    repoPath,
    ['diff', ...revisionArgs(range), '--numstat', '-z', '--no-color'],
    { allowFailure: true },
  )

  const files: FileCounts[] = []
  const fields = out.split('\0')
  for (let i = 0; i < fields.length;) {
    const record = fields[i++]
    if (!record) continue
    const [additions, deletions, path] = record.split('\t')
    if (additions === undefined || deletions === undefined) continue

    // An empty path means a rename: the old and new ones follow. The new one is
    // what the patch and the tree name it.
    let resolved = path
    if (!resolved) {
      i++
      resolved = fields[i++]
    }
    if (!resolved) continue

    // Binary files are reported as "-\t-\t<path>".
    const binary = additions === '-'
    files.push({
      path: resolved,
      additions: binary ? 0 : Number.parseInt(additions, 10),
      deletions: binary ? 0 : Number.parseInt(deletions, 10),
      binary,
    })
  }
  return files
}

/**
 * Per-file change kind.
 *
 * `--numstat` never says whether a file was added, deleted or renamed, and the
 * tree colours rows by that. `-M` folds an add/delete pair back into a rename.
 */
export async function nameStatus(
  repoPath: string,
  range: DiffRange,
): Promise<Map<string, GitStatus>> {
  const out = await git(repoPath, ['diff', ...revisionArgs(range), '--name-status', '-M', '-z'], {
    allowFailure: true,
  })

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
 * Synthesise a patch for untracked files, and the counts that go with it.
 *
 * They stay invisible to `git diff` until staged, and `git add -N` would mutate
 * the user's index. Diffed against /dev/null out of tree instead.
 *
 * `--numstat` rides in the same invocation rather than a second one: this is
 * already one process per file, and how many lines a file holds is git's answer
 * to give — counting the `+` here would have to know about binary files and
 * about "\ No newline at end of file".
 */
export async function untrackedPatch(
  repoPath: string,
  paths: string[],
): Promise<{ patch: string; counts: FileCounts[] }> {
  const chunks: string[] = []
  const counts: FileCounts[] = []
  for (const path of paths) {
    const out = await git(
      repoPath,
      ['diff', '--no-index', '--numstat', '-p', '--no-color', '--', '/dev/null', path],
      { allowFailure: true },
    )
    // The numstat line, a blank one, then the patch. Its path field is not read:
    // out of tree git writes it `/dev/null => <path>`, the same arrow no other
    // reading of the diff agrees with — and the path asked for is on hand.
    const [first = '', ...rest] = out.split('\n')
    const [additions, deletions] = first.split('\t')
    if (additions === undefined || deletions === undefined) continue
    const patch = rest.join('\n').trimStart()
    if (!patch) continue

    chunks.push(patch)
    const binary = additions === '-'
    counts.push({
      path,
      additions: binary ? 0 : Number.parseInt(additions, 10),
      deletions: binary ? 0 : Number.parseInt(deletions, 10),
      binary,
    })
  }
  return { patch: chunks.join(''), counts }
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
  const absolute = await gitDirPath(repoPath, '.')

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
