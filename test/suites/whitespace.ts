import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DiffPayload } from '../../src/types.ts'
import { allTreeRows, type Suite } from '../harness.ts'

export default {
  name: 'whitespace',
  async run({ page, load, repoPath, url }, check) {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim()
    const original = git('branch', '--show-current')
    const query = '?base=whitespace-base&target=whitespace-review'
    const toggle = '.whitespace-toggle input'
    const endpoint = new URL(url(query))
    const api = (route: string, suffix = '') =>
      `${endpoint.origin}${endpoint.pathname}/api/${route}${query}${suffix}`
    const waitForFiles = async (count: number) => {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('.review-tools-title > .counter')?.textContent ===
          String(expected),
        {},
        count,
      )
    }
    const ticked = () =>
      page.$$eval(
        '.viewed-toggle input',
        (inputs) => inputs.filter((input) => input.checked).length,
      )

    try {
      git('checkout', '-qb', 'whitespace-base', 'main')
      const before = Array.from(
        { length: 60 },
        (_, i) => `  const line_${i + 1} = ${i + 1};\n`,
      ).join('')
      writeFileSync(join(repoPath, 'whitespace-format.txt'), 'const value = 1;\n')
      writeFileSync(join(repoPath, 'whitespace-mixed.txt'), before)
      git('add', 'whitespace-format.txt', 'whitespace-mixed.txt')
      git('commit', '-qm', 'whitespace fixture base')
      git('checkout', '-qb', 'whitespace-review')
      writeFileSync(join(repoPath, 'whitespace-format.txt'), '\tconst value=1; \n')
      writeFileSync(
        join(repoPath, 'whitespace-mixed.txt'),
        before.replaceAll('  const', '\tconst').replace('line_30 = 30;', 'line_30 = 999;'),
      )
      git('add', 'whitespace-format.txt', 'whitespace-mixed.txt')
      git('commit', '-qm', 'format and edit')

      await load(query)
      check(
        'whitespace filtering starts disabled',
        !(await page.$eval(toggle, (input) => input.checked)),
      )
      const initial = (await (await fetch(api('diff'))).json()) as DiffPayload
      const seeded = await fetch(api('comments'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'whitespace-hidden',
          path: 'whitespace-format.txt',
          side: 'additions',
          start: 1,
          end: 1,
          body: 'Keep this formatting note',
          range: initial.range,
        }),
      })
      check('comment on a whitespace-only file is saved', seeded.ok)

      await page.click(toggle)
      await waitForFiles(1)
      check('the URL carries GitHub-style w=1', new URL(page.url()).searchParams.get('w') === '1')
      const files = (await allTreeRows(page)).filter((row) => row.kind === 'file')
      check(
        'the tree hides the whitespace-only file',
        files.length === 1 && files[0]?.path === 'whitespace-mixed.txt',
      )
      const filtered = (await (await fetch(api('diff', '&w=1'))).json()) as DiffPayload
      check(
        'counts describe only the substantive edit',
        filtered.totals.files === 1 &&
          filtered.totals.additions === 1 &&
          filtered.totals.deletions === 1,
      )

      await page.click('.view-toggle button:last-child')
      check('split view retains the filter', await page.$eval(toggle, (input) => input.checked))
      await page.reload({ waitUntil: 'networkidle0' })
      await waitForFiles(1)
      check(
        'reload restores the filter from the URL',
        await page.$eval(toggle, (input) => input.checked),
      )

      // Context expansion must load the two real files without restoring hidden hunks.
      const expandedResponse = page.waitForResponse(
        (response) => response.url().includes('/api/diff-files') && response.status() === 200,
      )
      const expand = await page.evaluate(() => {
        for (const host of document.querySelectorAll('.diff diffs-container')) {
          const button = host.shadowRoot?.querySelector<HTMLElement>('[data-expand-button]')
          if (button) {
            button.click()
            return true
          }
        }
        return false
      })
      check('a filtered hunk offers context expansion', expand)
      if (expand) {
        await expandedResponse
      }

      await page.click('.viewed-toggle input')
      await page.waitForFunction(() =>
        document.querySelector('.review-progress')?.textContent?.includes('1/1'),
      )
      await page.click(toggle)
      await waitForFiles(2)
      check('filtered Viewed does not mark the full diff read', (await ticked()) === 0)
      await page.click(toggle)
      await waitForFiles(1)
      await page.waitForFunction(() =>
        document.querySelector('.viewed-toggle input')?.matches(':checked'),
      )
      check('returning to the filtered view restores its Viewed tick', (await ticked()) === 1)

      const fullFile = initial.files.find((file) => file.path === 'whitespace-mixed.txt')
      if (!fullFile) throw new Error('missing mixed file in full comparison')
      const markedFull = await fetch(api('viewed'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          range: initial.range,
          path: fullFile.path,
          hash: fullFile.hash,
          viewed: true,
        }),
      })
      check('the full review can carry its own Viewed tick', markedFull.ok)
      const resetResponse = page.waitForResponse((response) =>
        response.url().includes('/api/viewed'),
      )
      await page.evaluate(() => {
        const reset = [
          ...document.querySelectorAll<HTMLButtonElement>('.sidebar-head button'),
        ].find((button) => button.textContent === 'Reset')
        if (!reset) throw new Error('missing Viewed Reset')
        reset.click()
      })
      const reset = await resetResponse
      check(
        'filtered Reset sends its whitespace scope',
        new URL(reset.url()).searchParams.get('w') === '1',
      )
      const fullAfterReset = (await (await fetch(api('diff'))).json()) as DiffPayload
      const filteredAfterReset = (await (await fetch(api('diff', '&w=1'))).json()) as DiffPayload
      check(
        'filtered Reset clears only its own Viewed state',
        fullAfterReset.viewed[fullFile.path] === fullFile.hash &&
          Object.keys(filteredAfterReset.viewed).length === 0,
      )

      await page.click('.comments-trigger')
      await page.waitForSelector('.comments-panel[open] [data-comment-id="whitespace-hidden"]')
      check(
        'comments on hidden files remain accessible',
        await page.$eval(
          '[data-comment-id="whitespace-hidden"]',
          (card) => card.textContent?.includes('Keep this formatting note') === true,
        ),
      )
      await page.click('[aria-label="Close comments"]')

      // The single formatting-only file becomes an explicitly filtered empty state.
      writeFileSync(join(repoPath, 'whitespace-format.txt'), 'const value =1;\t\n')
      await page.goto(url('?base=HEAD&w=1'), { waitUntil: 'networkidle0' })
      await page.waitForSelector('.message')
      check(
        'an empty filtered diff explains the setting',
        await page.$eval(
          '.message',
          (message) => message.textContent?.includes('whitespace changes hidden') === true,
        ),
      )
      await page.setViewport({ width: 390, height: 844 })
      check(
        'the setting remains available on mobile',
        await page.$eval(toggle, (input) => input.getBoundingClientRect().width > 0),
      )
    } finally {
      await fetch(`${endpoint.origin}${endpoint.pathname}/api/comments?id=whitespace-hidden`, {
        method: 'DELETE',
      })
      git(
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        'whitespace-format.txt',
        'whitespace-mixed.txt',
      )
      git('checkout', '-q', original)
      git('branch', '-D', 'whitespace-review', 'whitespace-base')
    }
  },
} satisfies Suite
