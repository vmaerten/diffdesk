import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import { buildPatch } from '../src/revision.ts'
import { comparisonReader } from '../src/comparison.ts'
import { asMarkdown } from '../src/export.ts'
import { putComment } from '../src/state.ts'
import type { Comment, DiffFiles, DiffPayload, ServedComment } from '../src/types.ts'
import { DIFF_SCROLLER, clickTreeRow, sleep, withHarness, type Check } from './harness.ts'

export async function runContext(check: Check): Promise<void> {
  const path = mkdtempSync(join(tmpdir(), 'ghl-context-'))
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim()
  const write = (name: string, text: string) => writeFileSync(join(path, name), text)
  const original = Array.from({ length: 180 }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
  const edited = original
    .replace('line 50\n', 'changed 50\n')
    .replace('line 130\n', 'changed 130\n')
  const server = createGhlServer({ repos: [{ repoPath: path }] })
  try {
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Context tests')
    git('config', 'user.email', 'context@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    write('context.txt', original)
    write('old name.txt', original)
    write('pure.txt', original.replaceAll('line', 'pure'))
    write('binary.bin', '\0old')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'feature')
    write('context.txt', edited)
    git('mv', 'old name.txt', 'renamed.txt')
    write('renamed.txt', edited)
    git('mv', 'pure.txt', 'moved.txt')
    write('binary.bin', '\0new')
    write('added.txt', 'new file\n')
    symlinkSync('/etc/hosts', join(path, 'link.txt'))
    git('add', '-A')
    git('commit', '-qm', 'changes')
    const commit = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'main')
    write('context.txt', original.replace('line 10\n', 'trunk 10\n'))
    git('commit', '-qam', 'advance trunk')
    git('checkout', '-q', 'feature')

    const port = await listen(server, 0)
    const base = `http://127.0.0.1:${port}/r/${repoIdFor(path)}`
    const diff = async (query = ''): Promise<DiffPayload> =>
      (await fetch(`${base}/api/diff?base=main&${query}`)).json()
    const expand = (data: DiffPayload, name = 'context.txt', query = '') => {
      const params = new URLSearchParams(query)
      params.set('base', 'main')
      params.set('path', name)
      params.set('hash', data.files.find((file) => file.path === name)?.hash ?? 'unknown')
      params.set('comparison', JSON.stringify(data.comparison))
      return fetch(`${base}/api/diff-files?${params}`)
    }
    for (const query of ['target=feature', 'committed=1', `commit=${commit}`, '']) {
      const data = await diff(query)
      check(
        `initial patch stays partial (${query || 'worktree'})`,
        !data.patch.includes('line 90\n'),
      )
      const response = await expand(data, 'context.txt', query)
      const files: DiffFiles = await response.json()
      check(
        `loads exact merge-base/parent and target (${query || 'worktree'})`,
        response.ok && files.oldFile?.contents === original && files.newFile?.contents === edited,
      )
      const rename: DiffFiles = await (await expand(data, 'renamed.txt', query)).json()
      check(
        'rename reads the previous path',
        rename.oldFile?.name === 'old name.txt' && rename.oldFile.contents === original,
      )
    }
    const data = await diff()
    const pure: DiffFiles = await (await expand(data, 'moved.txt')).json()
    check(
      'pure rename loads unchanged content',
      pure.oldFile === null && pure.newFile.contents === original.replaceAll('line', 'pure'),
    )
    for (const name of [
      '../outside',
      '/etc/hosts',
      'binary.bin',
      'link.txt',
      '.git/config',
      'missing.txt',
    ]) {
      check(`rejects ${name}`, !(await expand(data, name)).ok)
    }
    write('context.txt', edited.replace('line 90\n', 'working 90\n'))
    check('changed worktree rejects the displayed fingerprint', (await expand(data)).status === 409)
    const updated = await diff()
    const working: DiffFiles = await (await expand(updated)).json()
    check(
      'refresh permits the new worktree contents',
      working.newFile.contents.includes('working 90\n'),
    )
    write('context.txt', edited)

    // Read a snapshot, then mutate only hidden context. The patch hash on hand
    // still matches: blob verification must catch this second race itself.
    const snapshot = await buildPatch(path, 'main')
    write('context.txt', edited.replace('line 90\n', 'raced 90\n'))
    const raced = await comparisonReader(path, snapshot)
      .files('context.txt')
      .then(
        () => false,
        () => true,
      )
    check('reading rejects bytes that changed after patch construction', raced)
    write('context.txt', edited)

    const saved: { comment: ServedComment } = await (
      await fetch(`${base}/api/comments?base=main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'context-comment',
          path: 'context.txt',
          side: 'additions',
          start: 90,
          end: 91,
          range: data.range,
          body: 'Review this context',
        }),
      })
    ).json()
    check(
      'comment outside patch has its anchor and current code',
      saved.comment.anchor.join('|') === 'line 90|line 91' && !saved.comment.stale,
    )
    await putComment(path, {
      id: 'outside-comparison',
      path: 'absent.txt',
      side: 'additions',
      start: 1,
      end: 1,
      body: 'Keep this hidden comment',
      anchor: ['original'],
      range: 'other..range',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const resaved: { comment: ServedComment; comments: Comment[] } = await (
      await fetch(`${base}/api/comments?base=main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...saved.comment, body: 'Review this context again' }),
      })
    ).json()
    check(
      'saving an edit enriches its stored entry and preserves the original timestamp',
      resaved.comment.id === saved.comment.id &&
        resaved.comment.createdAt === saved.comment.createdAt &&
        resaved.comment.body === 'Review this context again' &&
        resaved.comment.code.join('|') === 'line 90|line 91' &&
        !resaved.comment.stale,
    )
    check(
      'save response keeps the full raw comment list, including hidden comments',
      resaved.comments.map((entry) => entry.id).join('|') ===
        'context-comment|outside-comparison' &&
        resaved.comments.every((entry) => !('code' in entry) && !('stale' in entry)),
    )
    const restored = await diff()
    check(
      'reload preserves comment status and HTTP export code',
      restored.comments.length === 1 &&
        restored.comments[0]?.code.join('|') === 'line 90|line 91' &&
        !restored.comments[0].stale &&
        asMarkdown(restored.comments, { range: restored.range }).includes('line 90'),
    )
    const cli = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [resolve('bin/ghl.ts'), 'comments', '--json', '--base', 'main'],
          { cwd: path, encoding: 'utf8' },
        ),
      )
    check('CLI exports context code', cli().comments[0]?.code.join('|') === 'line 90|line 91')
    write('context.txt', edited.replace('line 90\n', 'rewritten 90\n'))
    const stale = await diff()
    check(
      'edited context makes the comment stale',
      stale.comments[0]?.stale === true && stale.comments[0].code[0] === 'rewritten 90',
    )
    check('CLI exports changed context and its old anchor', cli().comments[0]?.was[0] === 'line 90')
    write('context.txt', edited)

    write('context.txt', `${edited}${'x'.repeat(20 * 1024 * 1024)}`)
    const large = await diff()
    const denied = await expand(large)
    check(
      '20 MB limit has an explicit error',
      !denied.ok && (await denied.text()).includes('20 MB'),
    )
    git('checkout', '-qb', 'oversized')
    git('add', 'context.txt')
    git('commit', '-qm', 'oversized before version')
    write('context.txt', edited)
    git('commit', '-qam', 'shrink file')
    const shrinkQuery = `commit=${git('rev-parse', 'HEAD')}`
    const oversizedBefore = await diff(shrinkQuery)
    check(
      'comment reads only its own version when the opposite side exceeds the limit',
      oversizedBefore.comments[0]?.stale === false &&
        oversizedBefore.comments[0].code[0] === 'line 90',
    )
    const beforeDenied = await expand(oversizedBefore, 'context.txt', shrinkQuery)
    check(
      '20 MB limit also applies to the before version',
      !beforeDenied.ok && (await beforeDenied.text()).includes('20 MB'),
    )
    git('checkout', '-q', 'feature')

    await withHarness(path, async (make) => {
      const harness = await make('feature')
      const { page, load } = harness
      let requests = 0
      page.on('request', (request) => {
        if (request.url().includes('/api/diff-files?')) requests++
      })
      const root = `[...document.querySelectorAll('.diff diffs-container')].find(host => host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim() === 'context.txt')?.shadowRoot`
      const rows = async () =>
        page.evaluate(
          `(() => { const root = ${root}; return root ? [...root.querySelectorAll('[data-line]')].map(el => el.textContent) : [] })()`,
        ) as Promise<string[]>
      const expandZone = async (index: number, direction: 'up' | 'down' | 'all') => {
        let clicked = false
        for (let attempt = 0; attempt < 20 && !clicked; attempt++) {
          clicked =
            (await page.evaluate(
              `(() => { const root = ${root}; const button = root?.querySelector('[data-expand-index="${index}"] [data-expand-${direction === 'all' ? 'all-button' : direction}]'); button?.click(); return Boolean(button) })()`,
            )) === true
          if (!clicked) {
            await page.evaluate(
              `(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop += 250 })()`,
            )
            await sleep(150)
          }
        }
        if (!clicked) throw new Error(`No ${direction} expansion control for zone ${index}`)
        await sleep(700)
      }
      await load('?base=main&target=feature')
      await clickTreeRow(page, 'added.txt')
      check(
        'complete added file has no context controls',
        (await page.evaluate(`(() => {
        const host = [...document.querySelectorAll('.diff diffs-container')].find(host => host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim() === 'added.txt');
        return Boolean(host) && !host.shadowRoot.querySelector('[data-expand-button]');
      })()`)) === true,
      )
      await clickTreeRow(page, 'context.txt')
      await sleep(500)
      check('no full content requested before expansion', requests === 0)
      check(
        'hidden context comment has no rendered slot',
        (await page.evaluate(
          `!(${root})?.querySelector('slot[name="annotation-additions-91"]')`,
        )) === true,
      )
      const stats = await page.$eval('.stats', (el) => el.textContent)
      const readingY = await page.evaluate(
        `(${root})?.querySelector('[data-line="50"]')?.getBoundingClientRect().top`,
      )
      await expandZone(1, 'up')
      check(
        'expansion preserves the reading position',
        (await page.evaluate(
          `(${root})?.querySelector('[data-line="50"]')?.getBoundingClientRect().top`,
        )) === readingY,
      )
      check(
        'first expansion reveals 20 lines after a hunk',
        (await rows()).some((line) => line.includes('line 73')) &&
          !(await rows()).some((line) => line.includes('line 74')),
      )
      const gutter = (await page.evaluate(`(() => {
        const rect = (${root})?.querySelector('[data-column-number="70"]')?.getBoundingClientRect();
        return rect ? { x: rect.x + 4, y: rect.y + rect.height / 2 } : null;
      })()`)) as { x: number; y: number } | null
      if (!gutter) throw new Error('Expanded line 70 has no selectable gutter')
      await page.mouse.click(gutter.x, gutter.y)
      await page.keyboard.press('c')
      await page.waitForSelector('.comment-composer textarea', { visible: true })
      await page.type('.comment-composer textarea', 'Comment from expanded line')
      await page.evaluate(
        `document.querySelector('.comment-composer footer button:last-child').click()`,
      )
      await sleep(900)
      const fromUI = (await diff('target=feature')).comments.find(
        (comment) => comment.body === 'Comment from expanded line',
      )
      check(
        'expanded lines are selectable and commentable in the UI',
        fromUI?.start === 70 && fromUI.anchor[0] === 'line 70' && !fromUI.stale,
      )
      await expandZone(1, 'down')
      await expandZone(1, 'up')
      check('repeated expansion reuses one request', requests === 1, String(requests))
      await expandZone(1, 'all')
      check(
        'fully revealed zone loses its separator',
        (await page.evaluate(`!(${root})?.querySelector('[data-expand-index="1"]')`)) === true,
      )
      await page.evaluate(`document.querySelector('.view-toggle button:last-child').click()`)
      await sleep(700)
      check(
        'split mode keeps the expansion',
        (await page.evaluate(`!(${root})?.querySelector('[data-expand-index="1"]')`)) === true &&
          requests === 1,
      )
      await clickTreeRow(page, 'renamed.txt')
      await clickTreeRow(page, 'context.txt')
      await sleep(700)
      check(
        'navigation keeps the expansion',
        (await page.evaluate(`!(${root})?.querySelector('[data-expand-index="1"]')`)) === true &&
          requests === 1,
      )
      check(
        'statistics stay unchanged',
        (await page.$eval('.stats', (el) => el.textContent)) === stats,
      )

      // Line 90's annotation exists only once its expanded zone enters the
      // virtual window. Scroll through that region, then inspect its real slot.
      await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop += 800 })()`)
      await sleep(800)
      check(
        'expanded context restores the saved comment',
        (await page.evaluate(
          `Boolean((${root})?.querySelector('slot[name="annotation-additions-91"]')) && [...document.querySelectorAll('.comment p')].some(el => el.textContent === 'Review this context again')`,
        )) === true,
      )
      await page.keyboard.down('Meta')
      await page.keyboard.press('f')
      await page.keyboard.up('Meta')
      await page.type('.diff-search-input', 'line 90')
      await sleep(300)
      check(
        'search excludes expanded context',
        (await page.$eval('.diff-search-count', (el) => el.textContent)) === 'No results',
      )
      await page.keyboard.press('Escape')
      await page.click('.refresh')
      await sleep(2000)
      await clickTreeRow(page, 'context.txt')
      check(
        'refresh resets expanded zones',
        (await page.evaluate(`Boolean((${root})?.querySelector('[data-expand-index="1"]'))`)) ===
          true,
      )
      check('refresh does not preload contents', requests === 1)
      await expandZone(0, 'down')
      await expandZone(0, 'all')
      check(
        'leading context reaches file boundary',
        (await rows()).some((line) => line.trim() === 'line 1'),
      )
      await expandZone(2, 'up')
      await expandZone(2, 'all')
      check(
        'trailing separator disappears at EOF',
        (await page.evaluate(`!(${root})?.querySelector('[data-expand-index="2"]')`)) === true,
      )
      // A recoverable transport failure keeps the patch and pending native
      // expansion. Retry resolves that same expansion without another click.
      await page.click('.refresh')
      await sleep(1500)
      await clickTreeRow(page, 'context.txt')
      await page.evaluate(`(() => {
        const originalFetch = window.fetch;
        let fail = true;
        window.fetch = (...args) => {
          if (String(args[0]).includes('/api/diff-files?') && fail) {
            fail = false;
            return Promise.reject(new Error('Temporary context failure'));
          }
          return originalFetch(...args);
        };
      })()`)
      await expandZone(1, 'up')
      check(
        'loading failure is visible while the patch remains',
        (await page.$eval('.context-error', (el) => el.textContent))?.includes(
          'Temporary context failure',
        ) === true && (await rows()).some((line) => line.includes('changed 50')),
      )
      await page.click('.context-error button')
      await sleep(1200)
      check(
        'retry completes the original expansion',
        !(await page.$('.context-error')) &&
          (await rows()).some((line) => line.includes('line 73')),
      )

      // Hold a successful response past a comparison change, even ignoring
      // AbortSignal in the transport. It must never hydrate the next diff.
      await page.click('.refresh')
      await sleep(1500)
      await clickTreeRow(page, 'context.txt')
      await page.evaluate(`(() => {
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (String(args[0]).includes('/api/diff-files?')) {
            window.fetch = originalFetch;
            await new Promise(resolve => { window.releaseContext = resolve; });
          }
          return response;
        };
      })()`)
      await expandZone(1, 'up')
      await page.waitForFunction('typeof window.releaseContext === "function"')
      await page.keyboard.press('t')
      await page.waitForSelector('.picker-input')
      await page.type('.picker-input', 'This checkout')
      await sleep(400)
      await page.keyboard.press('Enter')
      await sleep(1800)
      await clickTreeRow(page, 'context.txt')
      await page.evaluate('window.releaseContext()')
      await sleep(500)
      check(
        'late response cannot expand a different comparison',
        (await page.evaluate(`Boolean((${root})?.querySelector('[data-expand-index="1"]'))`)) ===
          true && !(await rows()).some((line) => line.includes('line 73')),
      )
      check(
        'comparison change retains the current query',
        (await page.evaluate('location.search.includes("target=")')) === false,
      )
      await expandZone(1, 'up')
      check(
        'new comparison can load its own context',
        (await rows()).some((line) => line.includes('line 73')),
      )

      // Marking an expanded file still uses the original patch fingerprint.
      await clickTreeRow(page, 'context.txt')
      await page.evaluate(`document.activeElement?.blur()`)
      await page.keyboard.press('v')
      await sleep(600)
      const viewed = await diff()
      check(
        'viewed fingerprint is unchanged by expansion',
        viewed.viewed['context.txt'] ===
          data.files.find((file) => file.path === 'context.txt')?.hash,
      )
      await page.click('.refresh')
      await sleep(1200)
      check(
        'viewed marker survives refresh',
        (await diff()).viewed['context.txt'] === viewed.viewed['context.txt'],
      )
      check('no browser errors', harness.errors.length === 0, harness.errors.join(' | '))
      await page.close()
    })
  } finally {
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(path, { recursive: true, force: true })
  }
}
