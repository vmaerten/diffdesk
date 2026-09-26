import { asExport, asMarkdown } from '../src/export.ts'
import type { ServedComment } from '../src/types.ts'
import type { Check } from './harness.ts'

export async function runExport(check: Check): Promise<void> {
  const comment: ServedComment = {
    id: 'e1a',
    path: 'src/one.ts',
    side: 'additions',
    start: 11,
    end: 12,
    body: 'first',
    anchor: ['  const added = 2', '  const alsoAdded = 3'],
    code: ['  const added = 2', '  const alsoAdded = 3'],
    stale: false,
    range: 'main..HEAD',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const forExport: ServedComment[] = [
    {
      ...comment,
      id: 'e2',
      path: 'src/two.ts',
      start: 1,
      end: 1,
      anchor: [],
      code: ['++ and these lead the added one'],
      body: 'second',
    },
    {
      ...comment,
      id: 'e1b',
      start: 12,
      end: 12,
      anchor: ['gone'],
      code: ['  const alsoAdded = 3'],
      stale: true,
      body: 'moved on',
    },
    comment,
  ]

  const shape = asExport(forExport, { repo: '/tmp/repo', range: 'main..HEAD' })
  // Path then line, not the order they were written: the export is read as a
  // list of places, and the tree's order exists for a pane there is none of here.
  check(
    'the export is ordered by path then line',
    shape.comments.map((c) => c.id).join(',') === 'e1a,e1b,e2',
    shape.comments.map((c) => c.id).join(','),
  )
  // Quoted from the current patch, not from the anchor: the agent is about to
  // edit what is there now, not what was there when the remark was written.
  check(
    '  quoting the lines as they read now',
    JSON.stringify(shape.comments[0]?.code) ===
      JSON.stringify(['  const added = 2', '  const alsoAdded = 3']),
    JSON.stringify(shape.comments[0]?.code),
  )
  // Only where it says something. A `was` on every entry, equal to `code`, is
  // noise that reads as meaningful.
  check(
    '  and carrying `was` only where the lines moved',
    shape.comments
      .filter((c) => c.was !== undefined)
      .map((c) => c.id)
      .join(',') === 'e1b',
    shape.comments.map((c) => `${c.id}:${c.was ? 'was' : '-'}`).join(' '),
  )

  const md = asMarkdown(forExport, { range: 'main..HEAD' })
  check(
    'markdown counts what it carries',
    md.startsWith('# 3 comments on main..HEAD'),
    md.split('\n')[0],
  )
  check(
    '  groups under one heading per file',
    (md.match(/^## .*/gm) ?? []).join(' | ') === '## src/one.ts | ## src/two.ts',
    (md.match(/^## .*/gm) ?? []).join(' | '),
  )
  check(
    '  labels a range as a range',
    md.includes('**L11–L12**'),
    md.includes('**L11–L12**') ? 'yes' : md,
  )
  check('  and a single line as one', md.includes('**L1**'), md.includes('**L1**') ? 'yes' : 'no')
  check(
    '  says so when the lines have moved',
    md.includes('These lines have changed'),
    md.includes('These lines have changed') ? 'yes' : 'no',
  )
  // No instruction: "apply these" is the prompt of whoever pastes it, and it is
  // not this tool's place to write that for them.
  check(
    '  and tells the reader nothing to do',
    !/apply|please|fix these/i.test(md),
    (md.match(/apply|please|fix these/i) ?? []).join(''),
  )
  check(
    'an empty review says so rather than printing a bare heading',
    asMarkdown([], { range: 'main..HEAD' }) === 'No comments on main..HEAD.\n',
    JSON.stringify(asMarkdown([], { range: 'main..HEAD' })),
  )
  const unavailable = asMarkdown([{ ...comment, code: [], stale: false }], { range: 'main..other' })
  check(
    'off-diff exports identify historical code instead of dropping its context',
    unavailable.includes('Code is unavailable') &&
      unavailable.includes(comment.anchor[0]!) &&
      !unavailable.includes('These lines have changed'),
  )
}
