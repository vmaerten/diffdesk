import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DiffPayload } from '../../src/types.ts'
import { COMMENTS_OPEN, type Suite } from '../harness.ts'

const BASE = `# Notes

Kept paragraph.

Edited paragraph.

- kept item
- edited item
`

const REVIEW = `# Notes

Kept paragraph.

Edited paragraph, now longer.

- kept item
- edited item, changed
- [a sibling](./other.md) and [the site](https://example.com)

| Column | Value |
| --- | --- |
| one | 1 |
`

export default {
  name: 'markdown',
  async run({ page, load, repoPath, url }, check) {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim()
    const original = git('branch', '--show-current')
    const query = '?base=markdown-base&target=markdown-review'
    const endpoint = new URL(url(query))
    const api = (route: string) => `${endpoint.origin}${endpoint.pathname}/api/${route}`
    const mode = (label: string) =>
      page.$eval(
        `[data-header-path="notes.md"] .markdown-mode button[aria-pressed="true"]`,
        (button, expected) => button.textContent === expected,
        label,
      )
    const press = (label: string) =>
      page.evaluate((text) => {
        const buttons = document.querySelectorAll<HTMLButtonElement>(
          '[data-header-path="notes.md"] .markdown-mode button',
        )
        ;[...buttons].find((button) => button.textContent === text)?.click()
      }, label)
    const changed = () =>
      page.$$eval('.markdown-preview [data-changed]', (nodes) =>
        nodes.map((node) => `${node.tagName.toLowerCase()}:${node.textContent?.trim()}`),
      )

    try {
      git('checkout', '-qb', 'markdown-base', 'main')
      writeFileSync(join(repoPath, 'notes.md'), BASE)
      git('add', 'notes.md')
      git('commit', '-qm', 'markdown fixture base')
      git('checkout', '-qb', 'markdown-review')
      writeFileSync(join(repoPath, 'notes.md'), REVIEW)
      git('commit', '-qam', 'edit notes')
      const diff = (await (await fetch(api(`diff${query}`))).json()) as DiffPayload
      await fetch(api('comments'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'markdown-note',
          path: 'notes.md',
          side: 'additions',
          start: 5,
          end: 5,
          body: 'Shorter, please',
          range: diff.range,
        }),
      })

      await load(query)
      await page.waitForSelector('[data-header-path="notes.md"] .markdown-mode')
      check('a Markdown file opens as source', await mode('Source'))

      await press('Rendered')
      await page.waitForSelector('.markdown-preview h1')
      check(
        'Rendered shows headings and GFM tables',
        await page.$eval('.markdown-preview', (preview) =>
          Boolean(preview.querySelector('h1') && preview.querySelector('table td')),
        ),
      )
      const marked = await changed()
      check(
        'only the blocks holding added lines are marked',
        marked.includes('p:Edited paragraph, now longer.') &&
          marked.includes('li:edited item, changed') &&
          marked.includes('tr:one1') &&
          !marked.some((block) => block.includes('Kept paragraph') || block === 'li:kept item'),
        marked.join(' | '),
      )
      check(
        'a relative link does not navigate the review',
        await page.$eval(
          '.markdown-preview',
          (preview) =>
            !preview.querySelector('a[href="./other.md"]') &&
            preview.querySelector('a[href="https://example.com"]')?.getAttribute('target') ===
              '_blank',
        ),
      )

      // A comment sits on source lines: viewing it brings them back.
      await page.click('.comments-trigger')
      await page.waitForSelector(`${COMMENTS_OPEN} [data-comment-id="markdown-note"]`)
      await page.click(`[data-comment-id="markdown-note"] .comment-navigation button`)
      await page.waitForFunction(() => !document.querySelector('.markdown-preview'))
      check('viewing a comment switches the file back to source', await mode('Source'))
      await page.click('[aria-label="Close comments"]')

      // A match is a source line too, selected once the source is back.
      await press('Rendered')
      await page.waitForSelector('.markdown-preview h1')
      await page.evaluate(() =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'f',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
      await page.waitForSelector('.diff-search:not([hidden]) .diff-search-input')
      await page.type('.diff-search-input', 'now longer')
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.diff diffs-container')].some((host) =>
          host.shadowRoot?.querySelector('[data-selected-line]'),
        ),
      )
      check(
        'a search match in a rendered file shows its source line',
        !(await page.$('.markdown-preview')) && (await mode('Source')),
      )
    } finally {
      await fetch(api('comments?id=markdown-note'), { method: 'DELETE' })
      git('checkout', '-q', original)
      git('branch', '-D', 'markdown-review', 'markdown-base')
    }
  },
} satisfies Suite
