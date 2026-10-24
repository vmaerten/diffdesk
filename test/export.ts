import { readFileSync } from 'node:fs'

import { asMarkdown } from '../src/export.ts'
import type { ServedComment } from '../src/types.ts'
import type { Check } from './harness.ts'

export async function runExport(check: Check): Promise<void> {
  const goldens: {
    repo: string
    range: string
    comments: ServedComment[]
    markdown: string
  }[] = JSON.parse(
    readFileSync(
      new URL('../go/internal/app/testdata/comment-export.json', import.meta.url),
      'utf8',
    ),
  )
  for (const [i, golden] of goldens.entries()) {
    check(`shared Markdown golden ${i}`, asMarkdown(golden.comments, golden) === golden.markdown)
  }
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

  const paths = ['\ue000.txt', '😀.txt', 'a.txt', 'A.txt', 'A.txt']
  const headings = (
    asMarkdown(
      paths.map((path, i) => ({ ...comment, path, id: String(i) })),
      { range: 'main..HEAD' },
    ).match(/^## .*/gm) ?? []
  ).join(' | ')
  check(
    'export ordering is stable across Unicode paths and locales',
    headings === '## A.txt | ## a.txt | ## 😀.txt | ## \ue000.txt',
    headings,
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
