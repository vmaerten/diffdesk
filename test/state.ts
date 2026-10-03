import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearViewed, putComment, readState, removeComment, setViewed } from '../src/state.ts'
import type { Check } from './harness.ts'

/**
 * A bare-bones repository, not the shared fixture.
 *
 * These checks are about `.git/ghl/state.json` — building 60 files and two
 * stack chains for that would only make them slower to run and slower to read.
 */
function scratchRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-state-'))
  execFileSync('git', ['init', '-q'], { cwd: path })
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

const stateFile = (repo: string) => join(repo, '.git', 'ghl', 'state.json')

export async function runState(check: Check): Promise<void> {
  const repo = scratchRepo()

  try {
    // ---- reading -----------------------------------------------------------

    const fresh = await readState(repo.path)
    check(
      'a repository with no state file reads as empty',
      Object.keys(fresh.state.viewed).length === 0 && fresh.notice === null,
      JSON.stringify(fresh),
    )

    await setViewed(repo.path, { range: 'main..HEAD', path: 'a.ts', hash: 'aaa', viewed: true })
    const written = await readState(repo.path)
    check(
      'a tick survives a round trip through the file',
      written.state.viewed['main..HEAD']?.['a.ts'] === 'aaa',
      JSON.stringify(written.state.viewed),
    )
    check(
      '  and the file records its version',
      written.state.version === 1,
      `${written.state.version}`,
    )

    // ---- atomicity ---------------------------------------------------------

    // The rename is what makes the write atomic, so nothing may be left behind:
    // a stray `.tmp` means the write happened somewhere the reader never looks.
    const strays = readdirSync(join(repo.path, '.git', 'ghl')).filter((f) => f.endsWith('.tmp'))
    check('writing leaves no temporary file behind', strays.length === 0, strays.join(', '))

    // ---- serialisation -----------------------------------------------------

    // Ten overlapping mutations, each on its own path. Unserialised, every one
    // reads the file before the others have written, so nine are lost — and the
    // loss is silent, which is the whole reason this is here.
    await clearViewed(repo.path, 'race')
    const paths = Array.from({ length: 10 }, (_, i) => `file${i}.ts`)
    await Promise.all(
      paths.map((path) => setViewed(repo.path, { range: 'race', path, hash: path, viewed: true })),
    )
    const raced = await readState(repo.path)
    const kept = Object.keys(raced.state.viewed['race'] ?? {})
    check(
      'concurrent writes all survive',
      kept.length === paths.length,
      `${kept.length} of ${paths.length} kept`,
    )

    // ---- a file that cannot be parsed --------------------------------------

    const file = stateFile(repo.path)
    writeFileSync(file, '{ this is not json')
    const broken = await readState(repo.path)
    check('an unreadable state file is reported', broken.notice !== null, broken.notice ?? 'null')
    check(
      '  and moved aside rather than overwritten',
      broken.notice !== null &&
        readdirSync(join(repo.path, '.git', 'ghl'))
          .filter((name) => name.endsWith('.corrupt'))
          .some(
            (name) =>
              readFileSync(join(repo.path, '.git', 'ghl', name), 'utf8') === '{ this is not json',
          ),
    )
    // Reported once, on the read that found it. Repeating it every refresh would
    // be a banner that never clears, on a file that no longer exists.
    const after = await readState(repo.path)
    check('  and the next read is clean again', after.notice === null, after.notice ?? 'null')

    // ---- comments ----------------------------------------------------------

    // A fresh tick: the section above moved the file aside on purpose, so the ten
    // from the race are legitimately gone and cannot witness anything.
    await setViewed(repo.path, { range: 'main..HEAD', path: 'kept.ts', hash: 'k', viewed: true })

    const comment = {
      id: 'c1',
      path: 'src/one.ts',
      side: 'additions' as const,
      start: 11,
      end: 12,
      body: 'extract this',
      anchor: ['  const added = 2', '  const alsoAdded = 3'],
      range: 'main..HEAD',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    await putComment(repo.path, comment)
    const withComment = await readState(repo.path)
    check(
      'a comment survives a round trip through the file',
      withComment.state.comments[0]?.body === 'extract this',
      JSON.stringify(withComment.state.comments),
    )

    // Same id, new body: an edit, not a second remark. The id comes from the
    // client precisely so a retried save cannot append a duplicate.
    await putComment(repo.path, {
      ...comment,
      body: 'rename it',
      createdAt: '2026-06-06T00:00:00.000Z',
    })
    const edited = await readState(repo.path)
    check(
      '  and the same id replaces rather than appends',
      edited.state.comments.length === 1,
      `${edited.state.comments.length}`,
    )
    check(
      '  keeping the body it was given',
      edited.state.comments[0]?.body === 'rename it',
      edited.state.comments[0]?.body,
    )
    // The original timestamp, not the new one: createdAt orders a thread, and
    // taking the edit's clock sends a comment to the bottom of its own thread
    // for having had a typo fixed.
    check(
      '  and the original createdAt',
      edited.state.comments[0]?.createdAt === '2026-01-01T00:00:00.000Z',
      edited.state.comments[0]?.createdAt,
    )

    await putComment(repo.path, { ...comment, id: 'c2', path: 'src/two.ts' })
    await removeComment(repo.path, 'c1')
    const removed = await readState(repo.path)
    check(
      'deleting takes one comment and leaves the rest',
      removed.state.comments.length === 1 && removed.state.comments[0]?.id === 'c2',
      removed.state.comments.map((c) => c.id).join(', '),
    )
    // Viewed ticks and comments live in the same file: the one must not carry off
    // the other, and the round trips above have rewritten it four times.
    check(
      '  without disturbing the viewed state',
      removed.state.viewed['main..HEAD']?.['kept.ts'] === 'k',
      JSON.stringify(removed.state.viewed['main..HEAD']),
    )
  } finally {
    repo.cleanup()
  }
}
