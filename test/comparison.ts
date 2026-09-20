import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { comparisonReader, resolveComparison, type ComparisonSelection } from '../src/comparison.ts'
import { EMPTY_TREE } from '../src/git.ts'
import { readImage } from '../src/images.ts'
import { sectionHashes } from '../src/state.ts'
import type { Check } from './harness.ts'

const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${color}</text></svg>`

export async function runComparison(check: Check): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'ghl-comparison-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const write = (path: string, contents: string) => writeFileSync(join(repo, path), contents)
  const resolve = (selection: ComparisonSelection = {}) =>
    resolveComparison(repo, { override: 'main', ...selection })
  const contents = async (url: string | null | undefined) => {
    if (!url) return null
    const params = new URL(url, 'http://localhost').searchParams
    return (await readImage(repo, params.get('revision')!, params.get('path')!)).toString()
  }

  try {
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Comparison tests')
    git('config', 'user.email', 'comparison@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    write('changed.svg', svg('red'))
    write('old badge.svg', svg('orange'))
    write('notes.txt', 'base\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const root = git('rev-parse', 'HEAD')

    git('checkout', '-qb', 'text-only')
    write('notes.txt', 'text only\n')
    git('commit', '-qam', 'text only')
    git('checkout', '-q', 'main')
    git('checkout', '-qb', 'feature')
    write('changed.svg', svg('blue'))
    write('notes.txt', 'feature\n')
    git('mv', 'old badge.svg', 'badge.svg')
    git('commit', '-qam', 'feature')
    const first = git('rev-parse', 'HEAD')
    git('checkout', '-qb', 'future')
    write('changed.svg', svg('green'))
    write('notes.txt', 'future\n')
    git('mv', 'badge.svg', 'next badge.svg')
    git('commit', '-qam', 'future')
    const next = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'feature')
    write('changed.svg', svg('yellow'))
    write('untracked.svg', svg('pink'))

    const committed = await (await resolve({ committed: true })).display('test')
    const working = await (await resolve()).display('test')
    check(
      'committed and working-tree comparisons retain their own image versions',
      committed.payload.comparison.after === first &&
        (await contents(
          committed.payload.files.find((f) => f.path === 'changed.svg')?.image?.after?.url,
        )) === svg('blue') &&
        working.payload.comparison.after === null &&
        working.payload.target.workingTree &&
        (await contents(
          working.payload.files.find((f) => f.path === 'changed.svg')?.image?.after?.url,
        )) === svg('yellow'),
    )
    const untracked = await (await resolve({ includeUntracked: true })).display('test')
    check(
      'untracked images join the comparison only when requested',
      !working.payload.files.some((f) => f.path === 'untracked.svg') &&
        untracked.payload.untrackedIncluded &&
        (await contents(
          untracked.payload.files.find((f) => f.path === 'untracked.svg')?.image?.after?.url,
        )) === svg('pink'),
    )
    const single = await (await resolve({ commitRef: first })).display('test')
    const initial = await (await resolve({ commitRef: root })).display('test')
    check(
      'single and root commits retain their own ranges and exclude working-tree files',
      single.payload.range === `${root}..${first}` &&
        initial.payload.range === `${EMPTY_TREE}..${root}` &&
        initial.payload.files.every((f) => !f.image || f.image.before === null) &&
        !single.payload.target.workingTree &&
        !initial.payload.target.workingTree &&
        single.payload.untracked.length === 0,
    )
    const fallback = await (
      await resolve({ commitRef: 'missing-commit', target: 'feature' })
    ).display('test')
    check(
      'an unresolved commit falls back to the branch with its notice',
      fallback.payload.commit === null &&
        fallback.payload.range === 'main..feature' &&
        fallback.payload.notice?.includes('missing-commit no longer resolves') === true &&
        fallback.payload.comparison.after === first,
    )
    const empty = await (await resolve({ target: 'main' })).display('test')
    check(
      'an empty comparison needs no images',
      empty.payload.files.length === 0 && Object.keys(empty.hashes).length === 0,
    )
    const textOnly = await (await resolve({ target: 'text-only' })).display('test')
    check(
      'a text-only comparison retains patch hashes without image enrichment',
      textOnly.payload.files.length === 1 &&
        textOnly.payload.files[0]?.image === undefined &&
        textOnly.payload.files[0]?.hash === sectionHashes(textOnly.payload.patch)['notes.txt'],
    )

    // Both readers share construction, even when display starts before patch completes.
    const snapshot = await resolve({ target: 'feature' })
    const [saved, before] = await Promise.all([snapshot.patch(), snapshot.display('test')])
    const lazy = await resolve({ target: 'feature' })
    git('update-ref', 'refs/heads/feature', next)
    const after = await snapshot.display('second-repo')
    const changed = after.payload.files.find((f) => f.path === 'changed.svg')!
    const renamed = after.payload.files.find((f) => f.path === 'badge.svg')!
    check(
      'display keeps the patch captured before a branch moves',
      after.patchResult === saved &&
        before.patchResult === saved &&
        after.payload.patch === before.payload.patch &&
        after.payload.comparison.after === first,
    )
    check(
      'image revisions and bytes follow the captured patch, not the moved branch',
      new URL(changed.image!.before!.url!, 'http://localhost').searchParams.get('revision') ===
        root &&
        new URL(changed.image!.after!.url!, 'http://localhost').searchParams.get('revision') ===
          first &&
        (await contents(changed.image?.before?.url)) === svg('red') &&
        (await contents(changed.image?.after?.url)) === svg('blue') &&
        changed.hash === before.hashes['changed.svg'],
    )
    check(
      'rename lookup stays on the captured comparison after the next commit renames it again',
      new URL(renamed.image!.before!.url!, 'http://localhost').searchParams.get('path') ===
        'old badge.svg' &&
        (await contents(renamed.image?.before?.url)) === svg('orange') &&
        (await contents(renamed.image?.after?.url)) === svg('orange'),
    )
    check(
      'display uses its repository id and keeps head metadata about the checkout',
      changed.image?.after?.url?.startsWith('/r/second-repo/') === true &&
        after.payload.head.sha === next &&
        after.payload.head.branch === 'feature',
    )
    const fresh = await (await resolve({ target: 'feature' })).display('test')
    check(
      'a fresh comparison observes moved refs and invalidates the changed image hash',
      fresh.payload.comparison.after === next &&
        fresh.hashes['changed.svg'] !== before.hashes['changed.svg'] &&
        (await contents(
          fresh.payload.files.find((f) => f.path === 'changed.svg')?.image?.after?.url,
        )) === svg('green'),
    )
    check(
      'an unread comparison captures refs only when its patch is first built',
      (await lazy.patch()).comparison.after === next,
    )
    check(
      'text hashes and context readers consume the same captured patch',
      after.hashes['notes.txt'] === sectionHashes(saved.patch)['notes.txt'] &&
        (
          await comparisonReader(repo, saved).lines({
            path: 'notes.txt',
            side: 'additions',
            start: 1,
            end: 1,
          })
        )?.[0] === 'feature',
    )

    const failed = await resolve({ target: 'missing-branch' })
    const rejected = await failed.patch().then(
      () => false,
      () => true,
    )
    git('branch', 'missing-branch', first)
    check(
      'a failed patch stays failed for its request; a new request can retry',
      rejected &&
        (await failed.patch().then(
          () => false,
          () => true,
        )) &&
        (await (await resolve({ target: 'missing-branch' })).patch()).comparison.after === first,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}
