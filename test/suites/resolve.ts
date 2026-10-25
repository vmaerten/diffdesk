import { asMarkdown } from '../../src/export.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiffPayload, StoredState } from '../../src/types.ts'
import { clickTreeRow, COMMENTS_OPEN, poll, type Suite } from '../harness.ts'

/** A resolved comment is closed but kept: out of the review, still in the state. */
export default {
  name: 'resolve',
  async run({ page, load, url, repoPath }, check) {
    await load()
    const endpoint = new URL(url())
    const api = (route: string) =>
      `${endpoint.origin}${endpoint.pathname}/api/${route}${endpoint.search}`
    const open = {
      id: 'resolve-open',
      path: 'src/core/cache.ts',
      side: 'additions',
      start: 24,
      end: 25,
      body: 'Extract this cache policy.',
      range: 'main..feature',
    }
    const resolved = { ...open, id: 'resolve-done', start: 26, end: 26, body: 'Done.' }
    for (const comment of [open, resolved]) {
      const response = await fetch(api('comments'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(comment),
      })
      check('seed comment accepted', response.ok)
    }
    const gitDir = execFileSync('git', ['-C', repoPath, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim()
    const stateFile = join(gitDir, 'ghl/state.json')
    const state: StoredState = JSON.parse(readFileSync(stateFile, 'utf8'))
    for (const comment of state.comments)
      if (comment.id === resolved.id) comment.status = 'resolved'
    writeFileSync(stateFile, JSON.stringify(state))
    await load()

    await clickTreeRow(page, open.path)
    const card = `.diff [data-comment-id="${open.id}"]`
    await page.waitForSelector(card)
    check(
      'a resolved comment is hidden from the diff',
      (await page.$(`.diff [data-comment-id="${resolved.id}"]`)) === null,
    )
    check(
      'the comment count leaves resolved comments out',
      (await page.$eval('.copy-all .counter', (el) => el.textContent?.trim())) === '1',
    )

    await page.click('.comments-trigger')
    await page.waitForSelector(COMMENTS_OPEN)
    check(
      'the panel leaves resolved comments out',
      JSON.stringify(
        await page.$$eval('.comments-panel .comment', (cards) =>
          cards.map((el) => el.getAttribute('data-comment-id')),
        ),
      ) === JSON.stringify([open.id]),
    )
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.documentElement.dataset.copied = value
          },
        },
      })
    })
    const payload = (await (await fetch(api('diff'))).json()) as DiffPayload
    await page.click('.comments-panel-toolbar button')
    check(
      'copy all leaves resolved comments out, like ghl comments',
      (await page.evaluate(() => document.documentElement.dataset.copied)) ===
        asMarkdown(
          payload.comments.filter((comment) => comment.status !== 'resolved'),
          { range: payload.range },
        ),
    )
    await page.click('[aria-label="Close comments"]')

    await page.click(`${card} .comment-resolve`)
    await page.waitForSelector(card, { hidden: true })
    const status = await poll(
      async () =>
        (JSON.parse(readFileSync(stateFile, 'utf8')) as StoredState).comments.find(
          (comment) => comment.id === open.id,
        )?.status,
      (value) => value === 'resolved',
    )
    check('Resolve closes a comment from the window and keeps it', status === 'resolved')
    check(
      '  and the count drops to nothing',
      (await page.$eval('.copy-all .counter', (el) => el.textContent?.trim())) === '0',
    )
  },
} satisfies Suite
