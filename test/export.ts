import { readFileSync } from 'node:fs'

import { asText } from '../src/export.ts'
import type { ServedComment } from '../src/types.ts'
import type { Check } from './harness.ts'

export async function runExport(check: Check): Promise<void> {
  const goldens: {
    repo: string
    range: string
    comments: ServedComment[]
    text: string
  }[] = JSON.parse(
    readFileSync(
      new URL('../go/internal/app/testdata/comment-export.json', import.meta.url),
      'utf8',
    ),
  )
  for (const [i, golden] of goldens.entries()) {
    check(`shared text golden ${i}`, asText(golden.comments, golden) === golden.text)
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
  const order = [
    ...asText(
      paths.map((path, i) => ({ ...comment, path, id: String(i) })),
      { range: 'main..HEAD' },
    ).matchAll(/^\S+ (.+):\d+(?:-\d+)?$/gm),
  ]
    .map((match) => match[1])
    .join(' | ')
  check(
    'export ordering is stable across Unicode paths and locales',
    order === 'A.txt | A.txt | a.txt | 😀.txt | \ue000.txt',
    order,
  )

  const text = asText(forExport, { range: 'main..HEAD' })
  check('the text counts what it carries', text.startsWith('3 comments on main..HEAD\n'), text)
  check(
    '  names each comment by ID and lines',
    text.includes('\ne1a src/one.ts:11-12\nfirst\n') &&
      text.includes('\ne2 src/two.ts:1\nsecond\n'),
    text,
  )
  check(
    '  leaves out the code the file still has',
    !text.includes('const added = 2') && !text.includes('and these lead'),
    text,
  )
  check(
    '  and quotes lines that have changed since',
    text.includes('moved on\nwas:\n  gone\n'),
    text,
  )
  const removed = asText([{ ...comment, side: 'deletions', code: ['removed()'] }], {
    range: 'main..HEAD',
  })
  check(
    '  or that the change removed',
    removed.includes('src/one.ts:11-12 (removed lines)\nfirst\ncode:\n  removed()\n'),
    removed,
  )
  // No instruction: "apply these" is the prompt of whoever pastes it, and it is
  // not this tool's place to write that for them.
  check(
    '  and tells the reader nothing to do',
    !/apply|please|fix these/i.test(text),
    (text.match(/apply|please|fix these/i) ?? []).join(''),
  )
  check(
    'an empty review says so rather than printing a bare count',
    asText([], { range: 'main..HEAD' }) === 'No comments on main..HEAD.\n',
    JSON.stringify(asText([], { range: 'main..HEAD' })),
  )
  const unavailable = asText([{ ...comment, code: [], stale: false }], { range: 'main..other' })
  check(
    'off-diff exports quote the lines as written instead of dropping their context',
    unavailable.includes(`was:\n  ${comment.anchor[0]}`),
    unavailable,
  )
}
