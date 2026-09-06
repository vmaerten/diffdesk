import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

/**
 * gh-stack's metadata belongs to the checkout that created it. In a linked
 * worktree that means the worktree Git directory, not the repository's common
 * `.git` directory.
 */
function stackedLinkedWorktree(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ghl-linked-worktree-'))
  const main = join(root, 'main')
  const linked = join(root, 'linked')
  mkdirSync(main)

  git(main, ['init', '-q', '--initial-branch=main'])
  git(main, ['config', 'user.email', 'worktree@example.invalid'])
  git(main, ['config', 'user.name', 'ghl worktree'])
  git(main, ['config', 'commit.gpgsign', 'false'])
  git(main, ['config', 'core.hooksPath', '/dev/null'])

  writeFileSync(join(main, 'base.ts'), 'export const base = 1\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-q', '-m', 'base'])

  git(main, ['checkout', '-q', '-b', 'stack/a'])
  writeFileSync(join(main, 'a.ts'), 'export const a = 1\n')
  git(main, ['add', '-A'])
  git(main, ['commit', '-q', '-m', 'bottom layer'])

  git(main, ['worktree', 'add', '-q', '-b', 'stack/b', linked, 'stack/a'])
  writeFileSync(join(linked, 'b.ts'), 'export const b = 1\n')
  git(linked, ['add', '-A'])
  git(linked, ['commit', '-q', '-m', 'top layer'])

  const gitDir = git(linked, ['rev-parse', '--git-dir']).trim()
  writeFileSync(
    resolve(linked, gitDir, 'gh-stack'),
    JSON.stringify({
      schemaVersion: 1,
      stacks: [
        {
          trunk: { branch: 'main' },
          branches: [{ branch: 'stack/a' }, { branch: 'stack/b' }],
        },
      ],
    }),
  )

  return { path: linked, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

export async function runWorktree(check: Check): Promise<void> {
  const repo = dirtyRepo()
  try {
    const paths = async (committed: boolean) =>
      (await buildPatch(repo.path, 'main', { committed, includeUntracked: true })).files
        .map((f) => f.path)
        .toSorted()

    const included = await paths(false)
    check(
      'the working tree is in the diff by default',
      included.join(', ') === 'committed.ts, staged.ts, unstaged.ts, untracked.ts',
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

    // A file in the patch is a file the diff counts: `numstat` and
    // `--name-status` never see an untracked one, so without this it was drawn
    // in the tree, reported as `+0 -0`, left out of the totals, and dropped by
    // `commentsIn` — which filters remarks on `files`.
    const stat = withThem.files.find((f) => f.path === 'untracked.ts')
    check(
      '  and counts as one of the files, with the lines git gives it',
      stat?.status === 'untracked' && stat.additions === 1 && stat.deletions === 0,
      JSON.stringify(stat) || 'absent',
    )
    check(
      '  which the totals say too',
      withThem.totals.files === 4,
      `${withThem.totals.files} file(s)`,
    )
    const without = await buildPatch(repo.path, 'main')
    check(
      '  and which it does not count when it is not showing it',
      without.files.every((f) => f.path !== 'untracked.ts') && without.totals.files === 3,
      `${without.totals.files} file(s): ${without.files.map((f) => f.path).join(', ')}`,
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

  const linked = stackedLinkedWorktree()
  try {
    const base = await resolveBase(linked.path)
    check(
      'a stack stored in a linked worktree is found',
      base.ref === 'stack/a' && base.source === 'stack',
      `${base.ref} (${base.source})`,
    )
    check(
      '  with the whole chain attached',
      base.stack?.layers.map((layer) => layer.branch).join(', ') === 'stack/a, stack/b',
      base.stack?.layers.map((layer) => layer.branch).join(', ') ?? 'no stack',
    )
  } finally {
    linked.cleanup()
  }
}
