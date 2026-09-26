import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { comparisonReader, resolveComparison, type ComparisonSelection } from '../src/comparison.ts'
import { EMPTY_TREE } from '../src/git.ts'
import { readImage } from '../src/images.ts'
import { putComment, readState } from '../src/state.ts'
import type { Comment, DiffSide } from '../src/types.ts'
import type { Check } from './harness.ts'

const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${color}</text></svg>`

export async function runComparison(check: Check): Promise<void> {
  await commentChecks(check)
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
        typeof textOnly.payload.files[0]?.hash === 'string' &&
        textOnly.payload.files[0].hash === textOnly.hashes['notes.txt'] &&
        (
          await comparisonReader(repo, textOnly.patchResult).files(
            'notes.txt',
            textOnly.payload.files[0].hash,
          )
        ).newFile.contents === 'text only\n',
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
      after.hashes['notes.txt'] === before.hashes['notes.txt'] &&
        after.hashes['notes.txt'] !== fresh.hashes['notes.txt'] &&
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

const comment = (id: string, overrides: Partial<Comment> = {}): Comment => ({
  id,
  path: 'lines.txt',
  side: 'additions',
  start: 11,
  end: 11,
  body: 'review this',
  anchor: ['added eleven'],
  range: 'old-base..old-branch',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

async function commentChecks(check: Check): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'ghl-comparison-comments-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const write = (path: string, contents: string) => writeFileSync(join(repo, path), contents)
  const original = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  const edited = original.replace('line 11\nline 12\n', 'added eleven\nadded twelve\n')
  const resolve = (selection: ComparisonSelection = {}) =>
    resolveComparison(repo, { override: 'main', ...selection })
  const reader = async (selection: ComparisonSelection = {}) =>
    comparisonReader(repo, await (await resolve(selection)).patch())

  try {
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Comment tests')
    git('config', 'user.email', 'comments@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    write('lines.txt', original)
    write('headers.txt', '-- old header\nunchanged\n')
    write('hidden.txt', 'unchanged\n')
    write('binary.bin', '\0before')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const earlier = git('rev-parse', 'HEAD')
    write('other.txt', 'another base\n')
    git('add', '-A')
    git('commit', '-qm', 'advance base')
    git('checkout', '-qb', 'feature')
    write('lines.txt', edited)
    write('headers.txt', '++ new header\nunchanged\n')
    write('binary.bin', '\0after')
    git('commit', '-qam', 'changes')

    const stored = [
      comment('twelve', { start: 12, end: 12, anchor: ['added twelve'] }),
      comment('hidden', { path: 'hidden.txt', start: 1, end: 1, anchor: ['unchanged'] }),
      comment('eleven'),
    ]
    for (const entry of stored) await putComment(repo, entry)
    const disk = await readState(repo)
    const serialized = JSON.stringify(disk.state.comments)
    const stateFile = join(repo, '.git', 'ghl', 'state.json')
    const beforeRead = readFileSync(stateFile, 'utf8')
    const read = async () => (await reader()).comments(disk.state.comments)
    const unchanged = await read()
    check(
      'comments select comparison files and preserve stored order',
      unchanged.map((entry) => entry.id).join(',') === 'twelve,eleven' &&
        unchanged.every((entry) => !entry.stale),
    )
    const otherBase = await (await reader({ override: earlier })).comments(disk.state.comments)
    check(
      'comments follow their file across bases regardless of the stored range',
      JSON.stringify(otherBase) === JSON.stringify(unchanged) &&
        otherBase.every((entry) => entry.range === 'old-base..old-branch'),
    )
    const hidden = await (await reader({ target: 'main' })).comments(disk.state.comments)
    check('a file outside the comparison hides its comments', hidden.length === 0)
    const overview = await (
      await reader({ target: 'main' })
    ).comments(disk.state.comments, { includeOutside: true })
    check(
      'the overview keeps off-diff comments without claiming their code changed',
      overview.length === disk.state.comments.length &&
        overview.every(
          (entry) => entry.code.length === 0 && !entry.stale && entry.anchor.length > 0,
        ),
    )

    write('lines.txt', edited.replace('added eleven\n', 'fixed eleven\n'))
    const partly = await read()
    check(
      'fixing one line stales only its comment, not the adjacent one',
      partly[1]?.stale === true &&
        partly[1].code[0] === 'fixed eleven' &&
        partly[0]?.stale === false &&
        partly[0].code[0] === 'added twelve',
    )
    write('lines.txt', edited.replace('line 50\n', 'changed elsewhere\n'))
    check(
      'a change elsewhere in the file stales neither comment',
      (await read()).every((c) => !c.stale),
    )
    write('lines.txt', edited)
    check(
      'restoring the text clears staleness on the next read',
      (await read()).every((c) => !c.stale),
    )

    const current = await reader()
    const at = (path: string, side: DiffSide, start: number, end = start) =>
      current.lines({ path, side, start, end })
    check(
      'reads an added line in the new file',
      (await at('lines.txt', 'additions', 11))?.join('|') === 'added eleven',
    )
    check(
      'reads a range of added lines',
      (await at('lines.txt', 'additions', 11, 12))?.join('|') === 'added eleven|added twelve',
    )
    check(
      'reads a range mixing context and added lines',
      (await at('lines.txt', 'additions', 10, 11))?.join('|') === 'line 10|added eleven',
    )
    check(
      'reads removed lines in the old file',
      (await at('lines.txt', 'deletions', 11, 12))?.join('|') === 'line 11|line 12',
    )
    check(
      'leading dashes in content are not file headers',
      (await at('headers.txt', 'deletions', 1))?.[0] === '-- old header',
    )
    check(
      'leading plus signs in content are not file headers',
      (await at('headers.txt', 'additions', 1))?.[0] === '++ new header',
    )
    check(
      'a range beyond the file returns null',
      (await at('lines.txt', 'additions', 400)) === null,
    )
    check(
      'a partially available range returns null',
      (await at('lines.txt', 'additions', 59, 61)) === null,
    )
    check('an absent file returns null', (await at('missing.txt', 'additions', 1)) === null)
    check('a backwards range returns null', (await at('lines.txt', 'additions', 12, 11)) === null)

    const outside = (['additions', 'deletions'] as const).map((side) =>
      comment(side, { side, start: 40, end: 41, anchor: ['line 40', 'line 41'] }),
    )
    const result = await (await resolve()).patch()
    const context = await comparisonReader(repo, result).comments(outside)
    check(
      'lines outside hunks remain readable on both sides without becoming stale',
      !result.patch.includes('line 40') &&
        context.length === 2 &&
        context.every((entry) => !entry.stale && entry.code.join('|') === 'line 40|line 41'),
    )
    const oldSide = await current.comments([
      comment('removed', { side: 'deletions', anchor: ['line 11'] }),
    ])
    check(
      'deletion comments compare against the old text',
      oldSide[0]?.code[0] === 'line 11' && !oldSide[0].stale,
    )

    const noAnchor = await current.comments([comment('empty', { anchor: [] })])
    check(
      'an empty anchor never marks available code stale',
      noAnchor[0]?.stale === false && noAnchor[0].code[0] === 'added eleven',
    )
    const shortAnchor = await current.comments([comment('short-anchor', { end: 12 })])
    check(
      'a different anchor length is stale even with matching first text',
      shortAnchor[0]?.stale === true && shortAnchor[0].code.length === 2,
    )
    write('lines.txt', edited.split('\n').slice(0, 11).join('\n') + '\n')
    const shortened = await (
      await reader()
    ).comments([comment('shortened', { end: 12, anchor: ['added eleven', 'added twelve'] })])
    check(
      'a range extending past a shortened file is stale with no code',
      shortened[0]?.stale === true && shortened[0].code.length === 0,
    )
    write('lines.txt', edited)

    const binary = await (
      await reader()
    ).comments([
      comment('binary', { path: 'binary.bin' }),
      comment('binary-empty', { path: 'binary.bin', anchor: [] }),
    ])
    check(
      'binary files retain comments with empty code and stale only nonempty anchors',
      binary.length === 2 &&
        binary.every((entry) => entry.code.length === 0) &&
        binary[0]?.stale === true &&
        binary[1]?.stale === false,
    )
    // Capture a comparison, then remove a source needed for out-of-hunk lines.
    // In-hunk lines are still readable from the captured patch.
    const unavailable = await reader()
    rmSync(join(repo, 'lines.txt'))
    const missing = await unavailable.comments([
      outside[0]!,
      { ...outside[0]!, id: 'missing-empty', anchor: [] },
      outside[1]!,
      comment('in-hunk'),
    ])
    check(
      'unreadable sources retain comments with empty code and stale only nonempty anchors',
      missing.length === 4 &&
        missing[0]?.code.length === 0 &&
        missing[0].stale &&
        missing[1]?.code.length === 0 &&
        !missing[1].stale,
    )
    check(
      'an unavailable new source leaves old-side and captured hunk comments readable',
      missing[2]?.code.join('|') === 'line 40|line 41' &&
        !missing[2].stale &&
        missing[3]?.code[0] === 'added eleven' &&
        !missing[3].stale,
    )
    check(
      'filtering and staleness never modify stored comments, anchors, or the state file',
      JSON.stringify(disk.state.comments) === serialized &&
        readFileSync(stateFile, 'utf8') === beforeRead,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}
