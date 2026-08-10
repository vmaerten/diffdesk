import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listRefDetails } from '../src/git.ts'
import { detectTrunk, resolveBase } from '../src/revision.ts'
import type { Check } from './harness.ts'

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/**
 * A checkout with a real remote, which the shared fixture deliberately has not.
 *
 * Nothing else here needs one, and the questions this suite asks — what the
 * picker offers, which name the trunk resolves to — are exactly the ones that
 * only have an answer once `origin/*` exists.
 */
function clonedRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ghl-refs-'))
  const origin = join(root, 'origin.git')
  const path = join(root, 'work')

  git(root, ['init', '-q', '--bare', origin])
  git(root, ['init', '-q', '--initial-branch=main', path])
  git(path, ['config', 'user.email', 'refs@example.invalid'])
  git(path, ['config', 'user.name', 'ghl refs'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  writeFileSync(join(path, 'README.md'), '# refs\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'base'])

  git(path, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(path, 'feature.ts'), 'export const feature = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'feature'])
  git(path, ['checkout', '-q', 'main'])

  git(path, ['remote', 'add', 'origin', origin])
  git(path, ['push', '-q', '-u', 'origin', 'main', 'feature'])
  // A branch that exists on the remote and nowhere else: the picker must not
  // offer it, and before this change it did.
  git(path, ['push', '-q', 'origin', 'main:refs/heads/never-checked-out'])
  git(path, ['fetch', '-q', 'origin'])
  git(path, ['remote', 'set-head', 'origin', 'main'])

  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * A trunk with a sibling forked below its tip, plus a remote.
 *
 * Shaped for base *resolution* rather than for what the pickers offer: the
 * sibling is the wrong answer that a fresh branch used to get, and it forks from
 * an older commit so it scores as a real candidate rather than being discarded.
 */
function forkedRepo(): { path: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ghl-fork-'))
  const origin = join(root, 'origin.git')
  const path = join(root, 'work')

  git(root, ['init', '-q', '--bare', origin])
  git(root, ['init', '-q', '--initial-branch=main', path])
  git(path, ['config', 'user.email', 'fork@example.invalid'])
  git(path, ['config', 'user.name', 'ghl fork'])
  git(path, ['config', 'commit.gpgsign', 'false'])
  git(path, ['config', 'core.hooksPath', '/dev/null'])

  writeFileSync(join(path, 'a.ts'), 'export const a = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'first'])

  git(path, ['checkout', '-q', '-b', 'sibling'])
  writeFileSync(join(path, 's.ts'), 'export const s = 1\n')
  git(path, ['add', '-A'])
  git(path, ['commit', '-q', '-m', 'sibling work'])

  git(path, ['checkout', '-q', 'main'])
  writeFileSync(join(path, 'a.ts'), 'export const a = 2\n')
  git(path, ['commit', '-q', '-am', 'main moves on'])

  git(path, ['remote', 'add', 'origin', origin])
  git(path, ['push', '-q', '-u', 'origin', 'main'])
  git(path, ['remote', 'set-head', 'origin', 'main'])

  return { path, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Which base a branch is given, which is a different question from which refs
 * exist — and the one where a wrong answer is a diff nobody asked for.
 */
async function checkGuessing(check: Check): Promise<void> {
  const repo = forkedRepo()
  const resolved = async () => {
    const base = await resolveBase(repo.path, {})
    return `${base.ref} (${base.source})`
  }

  try {
    // Cut and not committed to yet: HEAD *is* the trunk's tip, which used to
    // disqualify the trunk from its own tie-break and hand the branch a sibling.
    git(repo.path, ['checkout', '-q', '-b', 'fresh'])
    check(
      'a branch with no commits resolves to the trunk',
      (await resolved()) === 'main (trunk)',
      await resolved(),
    )

    git(repo.path, ['commit', '-q', '--allow-empty', '-m', 'one of its own'])
    check(
      '  and still does one commit later',
      (await resolved()) === 'main (trunk)',
      await resolved(),
    )

    // The reason `guessParent` exists at all: a branch stacked on another must
    // resolve to the one below, not to the trunk.
    git(repo.path, ['checkout', '-q', '-b', 'stacked'])
    git(repo.path, ['commit', '-q', '--allow-empty', '-m', 'on top'])
    check(
      'a stacked branch still resolves to the one below',
      (await resolved()) === 'fresh (guessed)',
      await resolved(),
    )

    // No local trunk: `detectTrunk` answers `origin/main`, which `localBranches`
    // does not list — so it was never scored, and the sibling won by default.
    git(repo.path, ['checkout', '-q', '--detach', 'origin/main'])
    git(repo.path, ['branch', '-q', '-D', 'main'])
    git(repo.path, ['checkout', '-q', '-b', 'fresh-remote'])
    check(
      'a remote-only trunk is scored too',
      (await resolved()) === 'origin/main (trunk)',
      await resolved(),
    )
  } finally {
    repo.cleanup()
  }
}

export async function runRefs(check: Check): Promise<void> {
  const repo = clonedRepo()
  try {
    const remotes = git(repo.path, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
    check(
      'the fixture really has remote refs',
      remotes.includes('origin/main') && remotes.includes('origin/never-checked-out'),
      remotes.split('\n').filter(Boolean).join(', '),
    )

    const offered = (await listRefDetails(repo.path)).map((ref) => ref.name)
    check(
      'the picker offers no origin ref',
      offered.every((name) => !name.startsWith('origin/')),
      offered.join(', '),
    )
    check(
      '  but every local branch',
      offered.includes('main') && offered.includes('feature'),
      offered.join(', '),
    )
    check(
      '  and not a branch that only exists on the remote',
      !offered.includes('never-checked-out'),
      offered.join(', '),
    )

    const trunk = await detectTrunk(repo.path)
    // `origin/HEAD` names the default branch; we take it under its local name so
    // the base shown in the topbar is one the picker can offer back.
    check('the trunk is the local branch origin/HEAD names', trunk === 'main', String(trunk))

    // Last resort: nothing local to point at.
    git(repo.path, ['checkout', '-q', 'feature'])
    git(repo.path, ['branch', '-q', '-D', 'main'])
    const fallback = await detectTrunk(repo.path)
    check(
      '  falling back to the remote when no local trunk exists',
      fallback === 'origin/main',
      String(fallback),
    )
  } finally {
    repo.cleanup()
  }

  await checkGuessing(check)
}
