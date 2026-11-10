import { readFileSync } from 'node:fs'

import { parsePatchFiles } from '@pierre/diffs'

import type { Check } from './harness.ts'

/** The page must number hunks as `diffdesk walkthrough` does, or a stop shows the wrong code. */
export async function runHunks(check: Check): Promise<void> {
  const goldens: { patch: string; hunks: string[] }[] = JSON.parse(
    readFileSync(
      new URL('../go/internal/app/testdata/walkthrough-hunks.json', import.meta.url),
      'utf8',
    ),
  )
  for (const [i, golden] of goldens.entries()) {
    const ids = parsePatchFiles(golden.patch, `hunks-${i}`)
      .flatMap((patch) => patch.files ?? [])
      .flatMap((file) => file.hunks.map((_, n) => `${file.name}#${n + 1}`))
    check(`hunk IDs golden ${i}`, ids.join('\n') === golden.hunks.join('\n'), ids.join(', '))
  }
}
