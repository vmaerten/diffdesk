import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPatch, resolveBase } from '../src/revision.ts'
import type { Check } from './harness.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/**
 * A branch with one commit above the base, and one of each kind of uncommitted
 * work: modified-unstaged, modified-staged, and untracked.
 *
 * The shared fixture is clean, and every browser suite reviews a ref, where the
 * working tree is out by construction — so the definition of what the button
 * excludes has nowhere else to be checked.
 */
function dirtyRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-worktree-'))
  git(path, ['init', '-q', '--initial-branch=main'])
  git(path, ['config', 'user.email', 'worktree@example.invalid'])
  git(path, ['config', 'user.name', 'ghl worktree'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  const write = (name: string, body: string) => writeFileSync(join(path, name), body)

  write('base.ts', 'export const base = 1\n')
  write('unstaged.ts', 'export const unstaged = 1\n')
  write('staged.ts', 'export const staged = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'base'])

  git(path, ['checkout', '-q', '-b', 'feature'])
  write('committed.ts', 'export const committed = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'the only commit'])

  write('unstaged.ts', 'export const unstaged = 2\n')
  write('staged.ts', 'export const staged = 2\n')
  git(path, ['add', 'staged.ts'])
  write('untracked.ts', 'export const untracked = 1\n')

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

export async function runWorktree(check: Check): Promise<void> {
  const repo = dirtyRepo()
  try {
    const paths = async (committed: boolean) =>
      (await buildPatch(repo.path, 'main', { committed, includeUntracked: true })).files
        .map((f) => f.path)
        .sort()

    const included = await paths(false)
    check(
      'the working tree is in the diff by default',
      included.join(', ') === 'committed.ts, staged.ts, unstaged.ts',
      included.join(', ') || 'nothing',
    )

    // Both halves of "uncommitted" go, not one: staged is as uncommitted as
    // unstaged, and a button that dropped only one would be a trap.
    const excluded = await paths(true)
    check(
      'committed only keeps the commit and drops the rest',
      excluded.join(', ') === 'committed.ts',
      excluded.join(', ') || 'nothing',
    )

    // Untracked files are asked for here — `includeUntracked: true` — and still
    // must not appear: they are as uncommitted as the other two.
    const listed = await buildPatch(repo.path, 'main', { committed: true, includeUntracked: true })
    check(
      '  including the untracked ones, asked for or not',
      listed.untracked.length === 0 && !listed.untrackedIncluded,
      `${listed.untracked.length} listed, included=${listed.untrackedIncluded}`,
    )
    const withThem = await buildPatch(repo.path, 'main', { includeUntracked: true })
    check(
      '  which the same call does show without the flag',
      withThem.untracked.join(', ') === 'untracked.ts' && withThem.untrackedIncluded,
      withThem.untracked.join(', ') || 'nothing',
    )

    // The trap this option exists to avoid: `HEAD` reaching `resolveBase`, which
    // reads it as a branch name and would look up `branch.HEAD.ghlBase`.
    git(repo.path, ['config', 'branch.feature.ghlBase', 'main'])
    const base = await resolveBase(repo.path, {})
    check(
      'the remembered base still answers with the flag on',
      base.ref === 'main' && base.source === 'remembered',
      `${base.ref} (${base.source})`,
    )
  } finally {
    repo.cleanup()
  }
}
