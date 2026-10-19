import { asMarkdown } from '../../src/export.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiffPayload, StoredState } from '../../src/types.ts'
import { clickTreeRow, sleep, type Suite } from '../harness.ts'

export default {
  name: 'review-panel',
  async run({ page, load, url, repoPath }, check) {
    await load()
    const endpoint = new URL(url())
    const api = (route: string) =>
      `${endpoint.origin}${endpoint.pathname}/api/${route}${endpoint.search}`
    const first = {
      id: 'panel-first',
      path: 'src/core/cache.ts',
      side: 'additions',
      start: 24,
      end: 25,
      body: 'Extract this cache policy.',
      range: 'main..feature',
    }
    const second = {
      ...first,
      id: 'panel-second',
      path: 'src/core/parser.ts',
      side: 'deletions',
      start: 44,
      end: 45,
      body: 'Keep this parser case covered.',
    }
    for (const comment of [first, second]) {
      const response = await fetch(api('comments'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(comment),
      })
      check('seed comment accepted', response.ok)
    }
    // The list must retain remarks on files absent from this comparison, and
    // changing their prose must preserve the original code and provenance.
    const gitDir = execFileSync('git', ['-C', repoPath, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
    }).trim()
    const stateFile = join(gitDir, 'ghl/state.json')
    const state: StoredState = JSON.parse(readFileSync(stateFile, 'utf8'))
    state.comments.push({
      id: 'panel-outside',
      path: 'removed-file.ts',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'Keep this migration note.',
      range: 'main..old-branch',
      branch: 'feature',
      anchor: ['original code'],
      createdAt: '2026-09-20T00:00:00Z',
    })
    writeFileSync(stateFile, JSON.stringify(state))
    await load()
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
    await page.click('.comments-trigger')
    await page.waitForSelector('.comments-panel[open]')
    check(
      'all comments are listed, including a file outside the diff',
      (await page.$$eval('.comments-panel .comment', (cards) => cards.length)) === 3,
    )
    check(
      'comments are grouped by file',
      (await page.$$eval('.comment-file', (groups) => groups.length)) === 3,
    )
    check(
      'missing code is explicitly identified',
      (await page.$eval(
        '[data-comment-id="panel-outside"] .comment-navigation',
        (el) => el.textContent,
      )) === 'Outside the current diff',
    )
    await page.click('.comments-panel-toolbar button')
    check(
      'copy all includes every listed comment and its code',
      (await page.evaluate(() => document.documentElement.dataset.copied)) ===
        asMarkdown(payload.comments, { range: payload.range }),
    )
    await page.click('.comments-panel [data-comment-id="panel-first"] .comment-copy')
    check(
      'individual copy contains only that comment',
      (await page.evaluate(() => document.documentElement.dataset.copied)) ===
        asMarkdown(
          payload.comments.filter((comment) => comment.id === first.id),
          { range: payload.range },
        ),
    )
    check(
      'individual copy confirms success',
      (await page.$eval(
        '.comments-panel [data-comment-id="panel-first"] .comment-copy',
        (el) => el.textContent,
      )) === 'Copied',
    )
    await page.click('[data-comment-id="panel-outside"] .comment-menu summary')
    await page.click('[data-comment-id="panel-outside"] .comment-menu-items button')
    await page.$eval('.panel-editor textarea', (el) => {
      if (el instanceof HTMLTextAreaElement) el.select()
    })
    await page.type('.panel-editor textarea', 'Updated migration note.')
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH')
    await page.click('.panel-editor button[type="submit"]')
    check('editing an off-diff comment succeeds', (await saved).ok())
    const editedPayload = (await (await fetch(api('diff'))).json()) as DiffPayload
    const edited = editedPayload.comments.find((comment) => comment.id === 'panel-outside')
    check(
      'editing preserves its code anchor and origin',
      edited?.body === 'Updated migration note.' &&
        edited.range === 'main..old-branch' &&
        edited.anchor[0] === 'original code' &&
        edited.createdAt === '2026-09-20T00:00:00Z',
    )
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard unavailable')
          },
        },
      })
    })
    await page.click('.comments-panel-toolbar button')
    await page.waitForSelector('.comments-panel [role="alert"]')
    check(
      'copy failures are visible inside the panel without claiming success',
      (await page.$eval('.comments-panel-toolbar button', (el) => el.textContent)) === 'Copy all',
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector('.comments-panel[open]', { hidden: true })
    check(
      'closing returns focus to the trigger',
      await page.$eval('.comments-trigger', (el) => el === document.activeElement),
    )

    await clickTreeRow(page, first.path)
    await sleep(500)
    await page.click('.diff [data-comment-id="panel-first"] .comment-collapse')
    await page.waitForSelector(
      '.diff [data-comment-id="panel-first"] .comment-collapse[aria-expanded="false"]',
    )
    await page.keyboard.press('v')
    await sleep(500)
    check(
      'the file is marked Viewed',
      ((await (await fetch(api('diff'))).json()) as DiffPayload).viewed[first.path] !== undefined,
    )
    await page.click('.comments-trigger')
    await page.click('.comments-panel [data-comment-id="panel-first"] .comment-navigation button')
    await page.waitForSelector('.comments-panel[open]', { hidden: true })
    await page.waitForSelector('.diff [data-comment-id="panel-first"]')
    await sleep(700)
    const position = await page.$eval('.diff [data-comment-id="panel-first"]', (el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, viewport: innerHeight }
    })
    check(
      'View in diff opens the folded file and reveals the comment',
      position.top > 0 && position.bottom < position.viewport,
      JSON.stringify(position),
    )
    const afterReveal = (await (await fetch(api('diff'))).json()) as DiffPayload
    check(
      'View in diff also expands a folded comment',
      await page.$eval(
        '.diff [data-comment-id="panel-first"] .comment-collapse',
        (el) => el.getAttribute('aria-expanded') === 'true',
      ),
    )
    check('revealing a comment preserves Viewed state', first.path in afterReveal.viewed)
    await page.keyboard.press('v')
    await sleep(250)
    await page.keyboard.press('v')
    await sleep(400)
    const folded = await page.evaluate(() => {
      const card = document.querySelector('.diff [data-comment-id="panel-first"]')
      const host = card?.closest('diffs-container')
      return {
        height: card?.getBoundingClientRect().height ?? 0,
        viewed: host?.querySelector<HTMLInputElement>('.viewed-toggle input')?.checked,
        text: host?.shadowRoot?.querySelector('[data-title]')?.textContent,
      }
    })
    check(
      'marking the revealed file Viewed again folds it',
      folded.height === 0,
      JSON.stringify(folded),
    )

    await page.setViewport({ width: 390, height: 844 })
    await sleep(500)
    check(
      'mobile dedicates its width to the diff',
      (await page.$eval('.diff', (el) => el.getBoundingClientRect().width)) === 390,
    )
    check(
      'mobile has no page overflow',
      await page.evaluate(() => document.documentElement.scrollWidth === innerWidth),
    )
    await page.click('.files-toggle')
    check(
      'mobile file list can be opened',
      (await page.$eval('.sidebar', (el) => el.getBoundingClientRect().width)) > 0,
    )
    await clickTreeRow(page, second.path)
    await sleep(300)
    check(
      'selecting a mobile file closes the drawer',
      (await page.$eval('.sidebar', (el) => el.getBoundingClientRect().width)) === 0,
    )
    await page.click('.comments-trigger')
    check(
      'mobile comments panel fills the viewport',
      (await page.$eval('.comments-panel', (el) => el.getBoundingClientRect().width)) === 390,
    )
    await page.keyboard.press('Escape')

    // Keep the shared fixture clean for subsequent suites.
    for (const id of [first.id, second.id, 'panel-outside']) {
      await fetch(`${api('comments')}&id=${id}`, { method: 'DELETE' })
    }
    await fetch(api('viewed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: payload.range, clear: true }),
    })
    await page.setViewport({ width: 1600, height: 1000 })
  },
} satisfies Suite
