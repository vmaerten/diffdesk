import type { Hunk } from '@pierre/diffs'

import { commentRange } from '../web/src/commentRange.ts'
import type { Check } from './harness.ts'

/** `@@ -17,14 +17,17 @@`: an added line, two more, then a line replaced. */
const hunk = {
  deletionStart: 17,
  additionStart: 17,
  hunkContent: [
    { type: 'context', lines: 3, additionLineIndex: 0, deletionLineIndex: 0 },
    { type: 'change', deletions: 0, additions: 1, deletionLineIndex: 3, additionLineIndex: 3 },
    { type: 'context', lines: 2, additionLineIndex: 4, deletionLineIndex: 3 },
    { type: 'change', deletions: 0, additions: 2, deletionLineIndex: 5, additionLineIndex: 6 },
    { type: 'context', lines: 5, additionLineIndex: 8, deletionLineIndex: 5 },
    { type: 'change', deletions: 1, additions: 1, deletionLineIndex: 10, additionLineIndex: 13 },
    { type: 'context', lines: 3, additionLineIndex: 14, deletionLineIndex: 11 },
  ],
} as unknown as Hunk

const lines = (start: number, end: number, side = 'additions') =>
  JSON.stringify({ side, start, end })

export async function runCommentRange(check: Check): Promise<void> {
  const range = (start: number, side: string, end: number, endSide: string) =>
    JSON.stringify(
      commentRange([hunk], {
        start,
        end,
        side: side as 'additions',
        endSide: endSide as 'additions',
      }),
    )

  check(
    'from a new line down to a removed one: the new lines above it',
    range(20, 'additions', 27, 'deletions') === lines(20, 29),
    range(20, 'additions', 27, 'deletions'),
  )
  check(
    '  whichever way it was dragged',
    range(27, 'deletions', 20, 'additions') === lines(20, 29),
    range(27, 'deletions', 20, 'additions'),
  )
  check(
    'from a removed line down to a new one: from its replacement on',
    range(27, 'deletions', 33, 'additions') === lines(30, 33),
    range(27, 'deletions', 33, 'additions'),
  )
  check(
    'a removed line past the hunk counts as the new line it became',
    range(30, 'additions', 40, 'deletions') === lines(30, 43),
    range(30, 'additions', 40, 'deletions'),
  )
  check(
    'one side keeps its own lines, in order',
    range(27, 'deletions', 27, 'deletions') === lines(27, 27, 'deletions') &&
      range(25, 'additions', 20, 'additions') === lines(20, 25),
  )
}
