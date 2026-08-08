import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearViewed,
  commentsIn,
  linesAt,
  markStale,
  putComment,
  readState,
  removeComment,
  setViewed,
} from '../src/state.ts'
import type { Check } from './harness.ts'

/**
 * A bare-bones repository, not the shared fixture.
 *
 * These checks are about `.git/ghl/state.json` and about parsing a patch handed
 * to them as a string — building 60 files and two stack chains for that would
 * only make them slower to run and slower to read.
 */
function scratchRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'ghl-state-'))
  execFileSync('git', ['init', '-q'], { cwd: path })
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

const stateFile = (repo: string) => join(repo, '.git', 'ghl', 'state.json')

/** One file per status, one hunk each, plus the shapes that trip a naive parser. */
const PATCH = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -10,4 +10,5 @@ export function one() {
   const kept = 1
-  const gone = 2
+  const added = 2
+  const alsoAdded = 3
   return kept
diff --git a/src/two.ts b/src/two.ts
index 3333333..4444444 100644
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,3 +1,3 @@
-- dashes lead this removed line
+++ and these lead the added one
 unchanged
`

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
      existsSync(`${file}.corrupt`) &&
        readFileSync(`${file}.corrupt`, 'utf8') === '{ this is not json',
      existsSync(`${file}.corrupt`) ? 'kept' : 'gone',
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
    const shown = commentsIn((await readState(repo.path)).state.comments, [
      'src/one.ts',
      'src/three.ts',
    ])
    // Filtered on the path, deliberately not on the range: a comment is filed
    // against code, so it follows its file across bases instead of vanishing
    // when `resolveBase` changes its mind on its own.
    check(
      'only comments on a file in the diff are served',
      shown.length === 1,
      shown.map((c) => c.path).join(', '),
    )
    check(
      '  whatever range they were written under',
      commentsIn((await readState(repo.path)).state.comments, ['src/one.ts']).every(
        (c) => c.range === 'main..HEAD',
      ),
    )

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

    // ---- staleness ---------------------------------------------------------

    // Two comments in the same file, on lines 11 and 12. This is the case the
    // feature exists for: an agent is handed both, fixes one, and the other must
    // not be swept along with it.
    const onEleven = {
      ...comment,
      id: 's1',
      start: 11,
      end: 11,
      anchor: ['  const added = 2'],
    }
    const onTwelve = {
      ...comment,
      id: 's2',
      start: 12,
      end: 12,
      anchor: ['  const alsoAdded = 3'],
    }

    const unchanged = markStale([onEleven, onTwelve], PATCH)
    check(
      'a comment whose lines still read the same is not stale',
      unchanged.every((c) => !c.stale),
      unchanged.map((c) => `${c.id}=${c.stale}`).join(' '),
    )

    // Line 11 rewritten, line 12 untouched.
    const oneFixed = PATCH.replace('+  const added = 2', '+  const extracted = two()')
    const partly = markStale([onEleven, onTwelve], oneFixed)
    check(
      'fixing one line stales that comment',
      partly.find((c) => c.id === 's1')?.stale === true,
      `s1=${partly.find((c) => c.id === 's1')?.stale}`,
    )
    // The whole point. A file-level hash would have flagged this one too, in the
    // one situation the feature is meant for — so the signal would never mean
    // anything.
    check(
      '  and leaves the one beside it alone',
      partly.find((c) => c.id === 's2')?.stale === false,
      `s2=${partly.find((c) => c.id === 's2')?.stale}`,
    )

    // A hunk elsewhere in the same file: nothing either comment points at moved.
    const elsewhere = PATCH.replace('   return kept', '   return kept // touched')
    check(
      'a change elsewhere in the file stales neither',
      markStale([onEleven, onTwelve], elsewhere).every((c) => !c.stale),
      markStale([onEleven, onTwelve], elsewhere)
        .map((c) => `${c.id}=${c.stale}`)
        .join(' '),
    )

    // The lines left the diff altogether — unknown, which is a change.
    check(
      'a comment whose lines left the patch is stale',
      markStale([onEleven], 'diff --git a/other.ts b/other.ts\n')[0]?.stale === true,
    )
    // Never captured, so there is no reference to have drifted from: claiming it
    // changed would be asserting something nobody measured.
    check(
      '  but one that never had an anchor is not',
      markStale([{ ...onEleven, anchor: [] }], oneFixed)[0]?.stale === false,
    )
    // A range that shrank counts: same first line, one line short.
    check(
      '  and a range that no longer spans as far is',
      markStale(
        [{ ...comment, id: 's3', start: 11, end: 12, anchor: ['  const added = 2'] }],
        PATCH,
      )[0]?.stale === true,
    )

    // Read-time only, like pruneStale: put the lines back and the flag clears.
    check(
      'staleness is not written to disk',
      (await readState(repo.path)).state.comments.every((c) => !('stale' in c)),
      JSON.stringify((await readState(repo.path)).state.comments.map((c) => Object.keys(c).length)),
    )

    // ---- linesAt -----------------------------------------------------------

    const at = (path: string, side: 'additions' | 'deletions', start: number, end = start) =>
      linesAt(PATCH, { path, side, start, end })

    // The hunk starts at new line 10: context, then the two added lines.
    check(
      'linesAt reads an added line by its number in the new file',
      JSON.stringify(at('src/one.ts', 'additions', 11)) === JSON.stringify(['  const added = 2']),
      JSON.stringify(at('src/one.ts', 'additions', 11)),
    )
    check(
      '  and a range spanning several added lines',
      JSON.stringify(at('src/one.ts', 'additions', 11, 12)) ===
        JSON.stringify(['  const added = 2', '  const alsoAdded = 3']),
      JSON.stringify(at('src/one.ts', 'additions', 11, 12)),
    )
    // Context counts on both sides, so a range may mix context and changes.
    check(
      '  and a range mixing context with a change',
      JSON.stringify(at('src/one.ts', 'additions', 10, 11)) ===
        JSON.stringify(['  const kept = 1', '  const added = 2']),
      JSON.stringify(at('src/one.ts', 'additions', 10, 11)),
    )
    // The removed line is line 11 of the *old* file, where line 11 of the new
    // one is something else entirely: asking on the wrong side is not a near miss.
    check(
      '  and a removed line by its number in the old file',
      JSON.stringify(at('src/one.ts', 'deletions', 11)) === JSON.stringify(['  const gone = 2']),
      JSON.stringify(at('src/one.ts', 'deletions', 11)),
    )
    // `--- a/x` and `+++ b/x` are indistinguishable from content once the marker
    // is stripped, so they are skipped by position rather than by looks.
    check(
      '  and content whose own leading dashes look like a file header',
      JSON.stringify(at('src/two.ts', 'deletions', 1)) ===
        JSON.stringify(['- dashes lead this removed line']),
      JSON.stringify(at('src/two.ts', 'deletions', 1)),
    )
    check(
      '  the same for leading plusses',
      JSON.stringify(at('src/two.ts', 'additions', 1)) ===
        JSON.stringify(['++ and these lead the added one']),
      JSON.stringify(at('src/two.ts', 'additions', 1)),
    )

    // Null, not blanks. These patches are partial, so a line the patch does not
    // carry is unknown — and an anchor of empty strings would compare equal to
    // the next unknown line, which is a stale comment reading as fresh.
    check(
      'linesAt returns null outside the hunks',
      at('src/one.ts', 'additions', 400) === null,
      JSON.stringify(at('src/one.ts', 'additions', 400)),
    )
    check(
      '  and null when only part of the range is known',
      at('src/one.ts', 'additions', 12, 40) === null,
      JSON.stringify(at('src/one.ts', 'additions', 12, 40)),
    )
    check(
      '  and null for a file the patch does not mention',
      at('src/absent.ts', 'additions', 1) === null,
      JSON.stringify(at('src/absent.ts', 'additions', 1)),
    )
    check(
      '  and null for a range that runs backwards',
      at('src/one.ts', 'additions', 12, 11) === null,
      JSON.stringify(at('src/one.ts', 'additions', 12, 11)),
    )
  } finally {
    repo.cleanup()
  }
}
