import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { commitDetail, EMPTY_TREE, listCommits } from '../src/git.ts'
import { buildCommitPatch } from '../src/revision.ts'
import type { Check } from './harness.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/**
 * A repository holding what the browser cannot reach.
 *
 * The shared fixture cannot carry these: no base puts a repository's first
 * commit inside a range, so the root case is unreachable through the UI, and a
 * merge of the trunk into the branch would change what every other suite reads.
 *
 * `main` ends up as: root -> a -> merge(side) -> empty.
 */
function shapedRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-commits-'))
  git(path, ['init', '-q', '--initial-branch=main'])
  git(path, ['config', 'user.email', 'commits@example.invalid'])
  git(path, ['config', 'user.name', 'ghl commits'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  writeFileSync(join(path, 'root.ts'), 'export const root = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'root'])

  writeFileSync(join(path, 'a.ts'), 'export const a = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'a'])

  git(path, ['checkout', '-q', '-b', 'side', 'HEAD~1'])
  writeFileSync(join(path, 'side.ts'), 'export const side = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'side'])

  git(path, ['checkout', '-q', 'main'])
  git(path, ['merge', '-q', '--no-ff', 'side', '-m', 'merge side'])
  git(path, ['commit', '-q', '--allow-empty', '-m', 'changes nothing'])

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

export async function runCommits(check: Check): Promise<void> {
  const repo = shapedRepo()
  try {
    const sha = (rev: string) => git(repo.path, ['rev-parse', rev]).trim()
    const root = git(repo.path, ['rev-list', '--max-parents=0', 'HEAD']).trim()

    const listed = await listCommits(repo.path, root, 'main')
    const subjects = listed.map((c) => c.subject)
    // The tip first, and every commit of the range present. Not the order of
    // the two siblings: they share a commit date to the second, so which comes
    // first is git's traversal rather than anything the picker should promise.
    check(
      'the commits of a range come back newest first',
      subjects[0] === 'changes nothing' && subjects[1] === 'merge side',
      subjects.join(' | '),
    )
    check(
      '  and the range holds every commit above the root',
      subjects.length === 4 && subjects.includes('a') && subjects.includes('side'),
      subjects.join(' | '),
    )

    const merge = listed.find((c) => c.subject === 'merge side')
    check(
      'a merge is recognised by its parents',
      merge?.parents.length === 2,
      String(merge?.parents.length),
    )
    // Zero would be a claim git never made: `--shortstat` prints nothing at all
    // for a merge, so the record is short and the counts are unknown.
    check('  and reports no counts', merge?.additions === null, String(merge?.additions))

    const empty = listed.find((c) => c.subject === 'changes nothing')
    check(
      'an empty commit reports no counts either',
      empty?.additions === null,
      String(empty?.additions),
    )

    const plain = listed.find((c) => c.subject === 'a')
    check(
      'a plain commit carries the counts of its own diff',
      plain?.additions === 1 && plain?.deletions === 0 && plain?.files === 1,
      `+${plain?.additions} -${plain?.deletions} in ${plain?.files}`,
    )

    // The trap: `git diff <root>^!` does not fail here, it compares the commit
    // to the working tree. Against the empty tree, the root commit is what it
    // added and nothing else.
    const first = await buildCommitPatch(repo.path, root)
    check('a root commit diffs against the empty tree', first.parent === EMPTY_TREE, first.parent)
    check(
      '  showing what it created, not the whole checkout',
      first.files.map((f) => `${f.status} ${f.path}`).join(', ') === 'added root.ts',
      first.files.map((f) => `${f.status} ${f.path}`).join(', ') || 'nothing',
    )

    // Against the first parent — the branch it was merged into — so what shows
    // is what the merge brought in. `--root` prints nothing at all here, and
    // `-m --first-parent` prints one record per parent.
    const merged = await buildCommitPatch(repo.path, sha('main~1'))
    check(
      'a merge diffs against its first parent',
      merged.files.map((f) => f.path).join(', ') === 'side.ts',
      merged.files.map((f) => f.path).join(', ') || 'nothing',
    )
    check('  and only once', merged.totals.files === 1, `${merged.totals.files} files`)

    const nothing = await buildCommitPatch(repo.path, sha('main'))
    check(
      'an empty commit builds an empty patch',
      nothing.files.length === 0 && nothing.patch === '',
      `${nothing.files.length} files, ${nothing.patch.length} bytes`,
    )

    const detail = await commitDetail(repo.path, sha('main~2'))
    check('one commit can be read on its own', detail?.subject === 'a', String(detail?.subject))
    const gone = await commitDetail(repo.path, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    // What the UI falls back on: a sha that stopped resolving after a rebase.
    check('a sha that does not resolve reads as nothing', gone === null, String(gone))
  } finally {
    repo.cleanup()
  }
}
