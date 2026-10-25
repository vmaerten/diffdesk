import type { Hunk, SelectedLineRange } from '@pierre/diffs'

import type { DiffSide } from '../../src/types.ts'

/**
 * Where a line sits among the new file's lines.
 *
 * A new or context line is its own number. A removed line has none: it sits
 * half a line before the first new line of its change, which is where a unified
 * diff draws it, so a selection that ends on it covers the new lines above.
 */
function newPosition(hunks: Hunk[], side: DiffSide, line: number): number {
  if (side === 'additions') return line
  let delta = 0
  for (const hunk of hunks) {
    if (line < hunk.deletionStart) break
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const block of hunk.hunkContent) {
      if (block.type === 'context') {
        if (line < oldLine + block.lines) return newLine + (line - oldLine)
        oldLine += block.lines
        newLine += block.lines
      } else {
        if (line < oldLine + block.deletions) return newLine - 0.5
        oldLine += block.deletions
        newLine += block.additions
      }
    }
    delta = newLine - oldLine
  }
  return line + delta
}

/**
 * The lines a selection comments on.
 *
 * A comment counts its lines in one file. A selection that runs from new lines
 * into removed ones, across a change in a unified diff or across the columns of
 * a split one, becomes the range of new lines it covers: the file an agent will
 * read and edit.
 */
export function commentRange(
  hunks: Hunk[],
  range: SelectedLineRange,
): { side: DiffSide; start: number; end: number } {
  const side = (range.side ?? 'additions') as DiffSide
  const endSide = (range.endSide ?? side) as DiffSide
  if (side === endSide)
    return {
      side,
      start: Math.min(range.start, range.end),
      end: Math.max(range.start, range.end),
    }
  const a = newPosition(hunks, side, range.start)
  const b = newPosition(hunks, endSide, range.end)
  return {
    side: 'additions',
    start: Math.ceil(Math.min(a, b)),
    end: Math.floor(Math.max(a, b)),
  }
}
