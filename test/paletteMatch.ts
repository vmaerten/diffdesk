import { matchedRanges } from '../web/src/paletteMatch.ts'
import type { Check } from './harness.ts'

const marks = (text: string, query: string) =>
  matchedRanges(text, query)
    .map(([start, end]) => text.slice(start, end))
    .join('|')

export async function runPaletteMatch(check: Check): Promise<void> {
  check('a substring is marked whole', marks('Copy All Comments', 'com') === 'Com')
  check(
    'other letters are marked in order, adjacent ones together',
    marks('Ignore Whitespace', 'igws') === 'Ig|W|s',
    marks('Ignore Whitespace', 'igws'),
  )
  check('letters out of order mark nothing', marks('Split', 'tps') === '')
}
