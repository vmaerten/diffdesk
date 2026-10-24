import { asMarkdown } from '../../src/export.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiffPayload, StoredState } from '../../src/types.ts'
import {
  clickTreeRow,
  COMMENTS_OPEN,
  frames,
  poll,
  settled,
  until,
  type Suite,
} from '../harness.ts'

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
    await page.waitForSelector(COMMENTS_OPEN)
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
    const copyLabel = await page.$eval('.comments-panel-toolbar button', (el) => el.textContent)
    check(
      'copy failures are visible inside the panel without claiming success',
      copyLabel?.startsWith('Copy all') === true,
      copyLabel ?? '',
    )
    await page.click('[aria-label="Close comments"]')
    await page.waitForSelector(COMMENTS_OPEN, { hidden: true })

    await clickTreeRow(page, first.path)
    await page.waitForSelector('.diff [data-comment-id="panel-first"] .comment-collapse')
    // A DOM click: the pane is still settling on the selected file, and a click
    // by coordinates could land beside the button.
    await page.$eval('.diff [data-comment-id="panel-first"] .comment-collapse', (button) =>
      (button as HTMLButtonElement).click(),
    )
    await page.waitForSelector(
      '.diff [data-comment-id="panel-first"] .comment-collapse[aria-expanded="false"]',
    )
    await page.keyboard.press('v')
    const viewed = await poll(
      async () => ((await (await fetch(api('diff'))).json()) as DiffPayload).viewed,
      (map) => map[first.path] !== undefined,
    )
    check('the file is marked Viewed', viewed[first.path] !== undefined)
    await page.click('.comments-trigger')
    await page.click('.comments-panel [data-comment-id="panel-first"] .comment-navigation button')
    await page.waitForSelector('.diff [data-comment-id="panel-first"]')
    const position = await poll(
      () =>
        page.$eval('.diff [data-comment-id="panel-first"]', (el) => {
          const r = el.getBoundingClientRect()
          return { top: r.top, bottom: r.bottom, viewport: innerHeight }
        }),
      (at) => at.top > 0 && at.bottom < at.viewport,
    )
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
    // A side panel, not a drawer: it stays beside the diff it navigated.
    check('the comments panel stays open', (await page.$(COMMENTS_OPEN)) !== null)
    const clickRevealed = (label: string) =>
      page.evaluate((text) => {
        const buttons = document.querySelectorAll<HTMLButtonElement>(
          '.diff [data-comment-id="panel-first"] header button, .diff .comment-composer footer button',
        )
        ;[...buttons].find((button) => button.textContent?.trim() === text)?.click()
      }, label)
    await clickRevealed('Edit')
    await page.waitForSelector('.diff .comment-composer textarea')
    await clickRevealed('Cancel')
    await page.waitForSelector('.diff .comment-composer', { hidden: true })
    // Nothing to wait for: the file must simply stay open once the page is quiet.
    await settled(page)
    await frames(page)
    check(
      'closing an edit keeps the revealed file open',
      await page.$eval(
        '.diff [data-comment-id="panel-first"]',
        (card) => card.getBoundingClientRect().height > 0,
      ),
    )
    const revealedViewed = `document.querySelector('.diff [data-comment-id="panel-first"]')
      ?.closest('diffs-container')?.querySelector('.viewed-toggle input')?.checked`
    await page.keyboard.press('v')
    await until(page, `${revealedViewed} === false`)
    await page.keyboard.press('v')
    const folded = await poll(
      () =>
        page.evaluate(() => {
          const card = document.querySelector('.diff [data-comment-id="panel-first"]')
          const host = card?.closest('diffs-container')
          return {
            height: card?.getBoundingClientRect().height ?? 0,
            viewed: host?.querySelector<HTMLInputElement>('.viewed-toggle input')?.checked,
            text: host?.shadowRoot?.querySelector('[data-title]')?.textContent,
          }
        }),
      (shown) => shown.height === 0,
    )
    check(
      'marking the revealed file Viewed again folds it',
      folded.height === 0,
      JSON.stringify(folded),
    )

    // Keep the shared fixture clean for subsequent suites.
    for (const id of [first.id, second.id, 'panel-outside']) {
      await fetch(`${api('comments')}&id=${id}`, { method: 'DELETE' })
    }
    await fetch(api('viewed'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: payload.range, clear: true }),
    })
  },
} satisfies Suite
