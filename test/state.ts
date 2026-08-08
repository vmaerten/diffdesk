import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearViewed, linesAt, readState, setViewed } from '../src/state.ts'
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
