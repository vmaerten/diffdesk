import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { asMarkdown } from '../../src/export.ts'
import type { DiffPayload } from '../../src/types.ts'
import { allTreeRows, DIFF_SCROLLER, frames, poll, settled, until, type Suite } from '../harness.ts'

/**
 * The gutter cell of the first mounted file, and the "+" the library puts in it
 * on hover.
 *
 * Read from the shadow root and clicked by coordinates: the button only exists
 * while the pointer is over its own gutter cell, so `querySelector(...).click()`
 * finds nothing to click.
 */
const GUTTER_CELL = `(() => {
  for (const host of document.querySelectorAll('.diff diffs-container')) {
    const root = host.shadowRoot
    const cell = root && root.querySelector('[data-gutter]')
    if (!cell) continue
    const r = cell.getBoundingClientRect()
    if (r.width === 0) continue
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  return null
})()`

const PLUS_BUTTON = `(() => {
  for (const host of document.querySelectorAll('.diff diffs-container')) {
    const root = host.shadowRoot
    const btn = root && root.querySelector('[data-utility-button]')
    if (!btn) continue
    const r = btn.getBoundingClientRect()
    if (r.width === 0) continue
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }
  return null
})()`

/**
 * Points on screen where a line number can be hovered.
 *
 * `[data-gutter]` is a whole column per hunk, not one cell per line, so a test
 * that wants *another* line samples down the column rather than looking for a
 * second element. Clipped to the viewport: hovering below the fold moves the
 * pointer nowhere and the utility button never appears.
 */
const GUTTER_POINTS = `(() => {
  const out = []
  const bottom = window.innerHeight
  for (const host of document.querySelectorAll('.diff diffs-container')) {
    const root = host.shadowRoot
    if (!root) continue
    for (const column of root.querySelectorAll('[data-gutter]')) {
      const r = column.getBoundingClientRect()
      if (r.width === 0) continue
      const from = Math.max(r.top + 6, 6)
      const to = Math.min(r.bottom - 6, bottom - 6)
      for (let y = from; y <= to; y += 24) out.push({ x: r.x + r.width / 2, y })
    }
  }
  return out
})()`

/**
 * The slots the cards are assigned to.
 *
 * The card is the assertion that matters, not the tree badge: a `renderAnnotation`
 * frozen behind a ref would keep the badge honest and leave the card empty. And
 * the slot *name* is the anchor — `annotation-additions-1` says which line and
 * which side the library paired it with, which a class name never would.
 */
const SLOTS = `[...document.querySelectorAll('.diff diffs-container > *')]
  .map((el) => el.getAttribute('slot'))
  .filter((s) => s && s.indexOf('annotation-') === 0)`

const clickButton = (label: string) =>
  `[...document.querySelectorAll('.comment header button, .comment-composer footer button')]
    .find((b) => b.textContent.trim() === '${label}')?.click()`

export default {
  name: 'comments',
  async run({ page, load, repoPath }, check) {
    const ready = async () => {
      await load()
      await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    }
    await ready()

    const count = (selector: string) =>
      page.evaluate(`document.querySelectorAll('${selector}').length`) as Promise<number>
    const slots = () => page.evaluate(SLOTS) as Promise<string[]>
    const bodies = () =>
      page.evaluate(
        `[...document.querySelectorAll('.comment p')].map((p) => p.textContent)`,
      ) as Promise<string[]>
    const composers = (n: number) =>
      until(page, `document.querySelectorAll('.comment-composer').length === ${n}`)
    const comments = (n: number) =>
      until(page, `document.querySelectorAll('.comment').length === ${n}`)
    const pencilled = async () =>
      (await allTreeRows(page)).filter((row) => row.decoration.includes('✎'))

    check('starts with no comment', (await count('.comment-thread')) === 0)

    // ---- the gutter "+" ----------------------------------------------------

    const cell = (await page.evaluate(GUTTER_CELL)) as { x: number; y: number } | null
    check('the diff has a gutter to hover', cell !== null, JSON.stringify(cell))
    if (!cell) return

    await page.mouse.move(cell.x, cell.y)
    await until(page, PLUS_BUTTON, 5_000)
    const plus = (await page.evaluate(PLUS_BUTTON)) as { x: number; y: number } | null
    check('hovering the gutter offers a "+"', plus !== null, JSON.stringify(plus))
    if (!plus) return

    await page.mouse.click(plus.x, plus.y)
    await until(page, `document.querySelectorAll('.comment-composer').length === 1`)
    check('clicking it opens a composer', (await count('.comment-composer')) === 1)
    // The library reports the range but not the file it is in, and it does so
    // before the selection is committed — so an annotation appearing on the right
    // line is what proves the path was recovered from the selection callback.
    check(
      '  anchored on the line it was opened from',
      (await slots())[0] === 'annotation-additions-1',
      (await slots()).join(', '),
    )

    // ---- the composer owns the keyboard ------------------------------------

    // Two different guards, and only one of them is the pre-existing one.
    //
    // With the field focused, `v` is a character: that is the INPUT/TEXTAREA
    // guard, and it was already there.
    await page.type('.comment-composer textarea', 'v')
    const typed = await page.evaluate(
      `(document.querySelector('.comment-composer textarea') || {}).value`,
    )
    check('a focused composer takes v as text', typed === 'v', String(typed))

    // With the focus elsewhere — which happens on its own, since the pane hands
    // focus back to its own root whenever it re-renders an item — nothing stops
    // `v` but the composer flag. Marking the file viewed would fold it shut and
    // carry the composer, draft included, off screen.
    await page.evaluate(`document.activeElement && document.activeElement.blur()`)
    await page.keyboard.press('v')
    await settled(page)
    check(
      '  and an unfocused one still blocks it',
      (await count('.comment-composer')) === 1 && (await pencilled()).length === 0,
      `${await count('.comment-composer')} composer(s), ${(await pencilled()).length} pencilled`,
    )

    // ---- saving ------------------------------------------------------------

    await page.evaluate(
      `(() => { document.querySelector('.comment-composer textarea').value = '' })()`,
    )
    await page.type('.comment-composer textarea', 'extract this expression')
    await page.evaluate(clickButton('Comment'))
    await until(
      page,
      `document.querySelectorAll('.comment').length === 1 && !document.querySelector('.comment-composer')`,
    )
    await settled(page)
    check('saving turns the composer into a comment', (await count('.comment')) === 1)
    check(
      '  carrying what was typed',
      (await bodies())[0] === 'extract this expression',
      (await bodies()).join(' | '),
    )
    check('  and no composer is left open', (await count('.comment-composer')) === 0)
    const copyLabel = () =>
      page.evaluate(
        `(() => { const b = document.querySelector('.titlebar-actions .copy-all'); return b && !b.disabled ? b.textContent : null })()`,
      )
    check(
      '  and the copy button counts it',
      (await copyLabel()) === 'Copy 1',
      String(await copyLabel()),
    )
    check(
      '  and the tree marks the file',
      (await pencilled()).length === 1,
      (await pencilled())[0]?.path,
    )

    // Copy before reloading: a GET can repair an incomplete save response and
    // hide the bug. Capture the clipboard write without browser permissions.
    const checkCopy = async (name: string) => {
      const payload = (await page.evaluate(`(async () => {
        return (await fetch(location.pathname + '/api/diff' + location.search)).json()
      })()`)) as DiffPayload
      const copied = await page.evaluate(`(async () => {
        let text = null
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (value) => { text = value } },
        })
        document.querySelector('.titlebar-actions .copy-all').click()
        await Promise.resolve()
        return text
      })()`)
      check(name, copied === asMarkdown(payload.comments, { range: payload.range }), String(copied))
      await until(
        page,
        `document.querySelector('.titlebar-actions .copy-all').textContent.startsWith('Copied')`,
        2_000,
      )
      check(
        '  and confirms the copy',
        (await page.evaluate(
          `document.querySelector('.titlebar-actions .copy-all').textContent.startsWith('Copied')`,
        )) === true,
      )
    }
    await checkCopy('a newly saved comment copies with its code without reloading')

    // The decisive one: the comment lives in .git/ghl/state.json, not in memory.
    await ready()
    await until(page, `document.querySelectorAll('.comment').length === 1`)
    check(
      'a comment survives a reload',
      (await count('.comment')) === 1,
      (await bodies()).join(' | '),
    )
    check(
      '  on the same line',
      (await slots())[0] === 'annotation-additions-1',
      (await slots()).join(', '),
    )
    check('  and the tree still marks the file', (await pencilled()).length === 1)

    const commentSize = () =>
      page.$eval('.diff .comment', (card) => ({
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
        host: card.closest('diffs-container')!.getBoundingClientRect().height,
      }))
    const expanded = await commentSize()
    check(
      'inline comments have a compact reading width and height',
      expanded.width <= 740 && expanded.height < 85,
      JSON.stringify(expanded),
    )
    for (const theme of ['github-dimmed', 'github-dark', 'catppuccin-frappe']) {
      await page.evaluate((value: string) => {
        document.documentElement.dataset.theme = value
      }, theme)
      await page.screenshot({ path: join(tmpdir(), `ghl-comment-${theme}.png`) })
    }
    await page.click('.comment-collapse')
    await page.waitForSelector('.comment-collapse[aria-expanded="false"]')
    await until(
      page,
      `document.querySelector('.diff .comment').getBoundingClientRect().height <= 38`,
      3_000,
    )
    const collapsed = await commentSize()
    check(
      'folding leaves a single-line preview and reclaims diff height',
      collapsed.height <= 38 &&
        expanded.host - collapsed.host >= 20 &&
        (await page.$eval(
          '.comment-preview',
          (element) => element.textContent === 'extract this expression',
        )),
      JSON.stringify({ expanded, collapsed }),
    )
    check(
      'collapse keeps keyboard focus on its control',
      await page.evaluate(
        () => document.activeElement?.classList.contains('comment-collapse') === true,
      ),
    )
    await page.screenshot({ path: join(tmpdir(), 'ghl-comment-collapsed.png') })
    await ready()
    await page.waitForSelector('.comment-collapse[aria-expanded="false"]')
    check(
      'folded comments survive reload',
      await page.$eval(
        '.comment [hidden]',
        (element) => element.getBoundingClientRect().height === 0,
      ),
    )
    await page.focus('.comment-collapse')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.comment-collapse[aria-expanded="true"]')
    check(
      'keyboard expands the original comment',
      (await bodies())[0] === 'extract this expression',
    )
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Split')
        ?.click(),
    )
    await until(
      page,
      `document.querySelector('.segmented button[title^="Split"]')?.ariaPressed === 'true'`,
    )
    await frames(page)
    const splitExpanded = await commentSize()
    await page.click('.comment-collapse')
    await page.waitForSelector('.comment-collapse[aria-expanded="false"]')
    const splitCollapsed = await poll(
      () => commentSize(),
      (size) => splitExpanded.host - size.host >= 20,
      3_000,
    )
    check(
      'split diff also reclaims folded comment height',
      splitExpanded.host - splitCollapsed.host >= 20,
      JSON.stringify({ splitExpanded, splitCollapsed }),
    )
    await page.click('.comment-collapse')
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Unified')
        ?.click(),
    )
    await until(
      page,
      `document.querySelector('.segmented button[title^="Unified"]')?.ariaPressed === 'true'`,
    )

    // The anchor never reaches the DOM, and nothing above would notice it being
    // empty — which is the whole basis of the staleness check to come. Asked of
    // the server directly, through the page so the repo id and origin are right.
    const stored = (await page.evaluate(`(async () => {
      const id = location.pathname.match(/^\\/r\\/([^/]+)/)[1]
      // Carry the page's own target: without it the server answers for another
      // revision, whose diff need not contain the file at all.
      const body = await (await fetch('/r/' + id + '/api/diff' + location.search)).json()
      const one = (body.comments || [])[0]
      return one ? { anchor: one.anchor, side: one.side, start: one.start, end: one.end, range: one.range } : null
    })()`)) as { anchor: string[]; side: string; start: number; end: number; range: string } | null
    check(
      'the server kept the lines the comment was written against',
      (stored?.anchor.length ?? 0) === 1,
      JSON.stringify(stored),
    )
    check(
      '  and the range it was written under',
      typeof stored?.range === 'string' && stored.range.includes('..'),
      stored?.range,
    )

    // ---- editing -----------------------------------------------------------

    await page.click('.comment-collapse')
    await page.waitForSelector('.comment-collapse[aria-expanded="false"]')
    await page.evaluate(clickButton('Edit'))
    await composers(1)
    const prefilled = await page.evaluate(
      `(document.querySelector('.comment-composer textarea') || {}).value`,
    )
    check('editing reopens the composer', (await count('.comment-composer')) === 1)
    check(
      '  prefilled with the comment',
      prefilled === 'extract this expression',
      String(prefilled),
    )
    // Hidden while its editor is open, or the text would show twice — once
    // stored, once being rewritten.
    check('  and the stored copy steps aside', (await count('.comment')) === 0)

    // Keep the edit unsaved while refresh reads the old copy of the same ID.
    await page.evaluate(`(() => {
      const original = window.fetch
      window.__restoreCommentFetch = () => { window.fetch = original }
      window.fetch = (input, init) => {
        if (String(input).includes('/api/comments') && init?.method === 'PATCH') {
          return new Promise((resolve, reject) => {
            window.__releaseCommentSave = () => {
              original(input, init).then(resolve, reject)
              window.fetch = original
            }
          })
        }
        return original(input, init)
      }
    })()`)

    await page.evaluate(
      `(() => { const t = document.querySelector('.comment-composer textarea'); t.value = 'rename it too'; t.dispatchEvent(new Event('change', { bubbles: true })) })()`,
    )
    await page.evaluate(clickButton('Update'))
    await poll(
      () => bodies(),
      (shown) => shown[0] === 'rename it too',
    )
    check(
      'updating rewrites the body',
      (await bodies())[0] === 'rename it too',
      (await bodies()).join(' | '),
    )
    // One comment, not two: the id comes from the client, so an edit rewrites its
    // own entry instead of appending a second one.
    check('  and does not add a second comment', (await count('.comment')) === 1)
    await page.evaluate(`document.activeElement?.blur()`)
    const refreshed = page.waitForResponse((response) => /\/api\/diff(?:\?|$)/.test(response.url()))
    await page.keyboard.press('r')
    await refreshed
    await settled(page)
    check(
      'refresh preserves an unsaved edit even when the server returns its old ID',
      (await bodies())[0] === 'rename it too' &&
        (await page.evaluate(`document.querySelector('.comment-state')?.textContent`)) ===
          'Saving…',
      (await bodies()).join(' | '),
    )
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/comments') && response.request().method() === 'PATCH',
    )
    await page.evaluate(`window.__releaseCommentSave(); window.__restoreCommentFetch()`)
    await saved
    await page.waitForFunction(() => !document.querySelector('.comment-state'))
    await checkCopy('an edited comment copies with its code without reloading')

    // ---- cancelling lets go of the line ------------------------------------

    // Reported from the browser: cancel once, and the diff looked frozen — every
    // later click reopened the line just abandoned.
    //
    // A closed composer used to leave the library's selection standing, and while
    // one stands the "+" is pinned to the bottom of it instead of following the
    // pointer. Nothing on the page could clear it, so the only way out was a
    // reload.
    await page.mouse.move(cell.x, cell.y)
    await until(page, PLUS_BUTTON, 5_000)
    const plusAgain = (await page.evaluate(PLUS_BUTTON)) as { x: number; y: number } | null
    if (plusAgain) {
      await page.mouse.click(plusAgain.x, plusAgain.y)
      await composers(1)
      await page.keyboard.press('Escape')
      await composers(0)
      check('escape closes the composer', (await count('.comment-composer')) === 0)

      const points = (await page.evaluate(GUTTER_POINTS)) as { x: number; y: number }[]
      const elsewhere = points.findLast((p) => Math.abs(p.y - cell.y) > 40)
      if (elsewhere) {
        await page.mouse.move(elsewhere.x, elsewhere.y)
        await until(page, `Math.abs((${PLUS_BUTTON})?.y - ${elsewhere.y}) < 20`, 5_000)
        const moved = (await page.evaluate(PLUS_BUTTON)) as { x: number; y: number } | null
        check(
          '  and the "+" follows the pointer again',
          moved !== null && Math.abs(moved.y - elsewhere.y) < 20,
          `at y=${moved?.y ?? 'none'}, wanted ${elsewhere.y}, abandoned line was at ${cell.y}`,
        )
        if (moved) {
          await page.mouse.click(moved.x, moved.y)
          await composers(1)
          // The anchor, not merely that *a* composer opened: reopening the
          // abandoned line would leave one on screen too, and that is the bug.
          // A slot that is not line 1's. The comment saved earlier still holds
          // that one, so counting composers would pass even on the abandoned line
          // — the anchor is the only thing that tells the two apart.
          const reopened = (await page.evaluate(SLOTS)) as string[]
          check(
            '  so another line can be commented',
            reopened.some((slot) => slot !== 'annotation-additions-1'),
            reopened.join(', ') || 'nothing',
          )
          await page.keyboard.press('Escape')
          await composers(0)
        }
      }
    }

    // ---- `c` on a selection ------------------------------------------------

    // The gutter cell itself, not the "+" inside it: that selects without opening
    // anything, which is the state `c` exists for.
    await page.mouse.click(cell.x, cell.y)
    await until(
      page,
      `[...document.querySelectorAll('.diff diffs-container')].some((host) => host.shadowRoot?.querySelector('[data-selected-line]'))`,
      5_000,
    )
    check('clicking the gutter selects without composing', (await count('.comment-composer')) === 0)
    await page.keyboard.press('c')
    await composers(1)
    check('  and c comments that selection', (await count('.comment-composer')) === 1)

    // A card leaves the DOM with its virtualised file. Its draft belongs to the
    // review renderer, so scrolling it back must restore the text and anchor.
    await page.type('.comment-composer textarea', 'keep this draft across scrolling')
    const draftSlots = await slots()
    const draftScroll = await page.evaluate(`(() => {
      document.activeElement?.blur()
      const scroller = ${DIFF_SCROLLER}
      const top = scroller.scrollTop
      scroller.scrollTop = scroller.scrollHeight
      return top
    })()`)
    await page.waitForFunction(`document.querySelector('.comment-composer') === null`)
    check('scrolling away unmounts the draft card', (await count('.comment-composer')) === 0)
    await page.evaluate(`${DIFF_SCROLLER}.scrollTop = ${draftScroll}`)
    await page.waitForSelector('.comment-composer textarea')
    check(
      'scrolling back restores the draft on the same lines',
      (await page.$eval(
        '.comment-composer textarea',
        (el) => (el as HTMLTextAreaElement).value,
      )) === 'keep this draft across scrolling' &&
        (await slots()).join('|') === draftSlots.join('|'),
    )
    await page.keyboard.press('Escape')

    // ---- deleting ----------------------------------------------------------

    // The selection exercise above can leave the pane far enough down for the
    // original card to fall outside the virtual window. Reload at its file
    // before asking its button to delete it: absence from the DOM is not a click.
    await ready()
    await comments(1)
    await page.evaluate(clickButton('Delete'))
    await comments(0)
    await settled(page)
    check('deleting removes the comment', (await count('.comment')) === 0)
    check('  and clears the tree badge', (await pencilled()).length === 0)
    check(
      '  and disables copying an empty review',
      await page.$eval(
        '.copy-all',
        (button) => button instanceof HTMLButtonElement && button.disabled,
      ),
    )

    await ready()
    check('  for good', (await count('.comment')) === 0)

    // ---- lines that moved --------------------------------------------------

    // Reviewing a ref reads git objects, so editing the checkout would change
    // nothing: this part works on the working tree, where an edit is the diff.
    // The tree is left as it was found — the fixture is built once per run.
    const scratch = join(repoPath, 'stale-probe.ts')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath })
    const original = ['const first = 1', 'const second = 2', 'const third = 3']
    const stage = (lines: string[]) => {
      writeFileSync(scratch, lines.join('\n') + '\n')
      git('add', 'stale-probe.ts')
    }
    /** The comment as the server holds it, so the test edits the line it is on. */
    const servedComment = () =>
      page.evaluate(`(async () => {
        const id = location.pathname.match(/^\\/r\\/([^/]+)/)[1]
        const body = await (await fetch('/r/' + id + '/api/diff' + location.search)).json()
        return (body.comments || [])[0] || null
      })()`) as Promise<{ start: number; anchor: string[]; stale: boolean } | null>

    try {
      stage(original)

      // No target: the working tree of the checkout, which is where the edit lands.
      await load('')
      await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
      await until(page, GUTTER_CELL)

      const freshCell = (await page.evaluate(GUTTER_CELL)) as { x: number; y: number } | null
      if (!freshCell) {
        check('the working tree shows the scratch file', false, 'no gutter found')
        return
      }
      await page.mouse.move(freshCell.x, freshCell.y)
      await until(page, PLUS_BUTTON, 5_000)
      const freshPlus = (await page.evaluate(PLUS_BUTTON)) as { x: number; y: number } | null
      if (!freshPlus) {
        check('the working tree offers a "+"', false, 'no button found')
        return
      }
      await page.mouse.click(freshPlus.x, freshPlus.y)
      await composers(1)
      await page.type('.comment-composer textarea', 'this constant needs a name')
      await page.evaluate(clickButton('Comment'))
      await comments(1)
      await settled(page)
      check('a comment on the working tree saves', (await count('.comment')) === 1)
      check('  and starts out fresh', (await count('.comment.stale')) === 0)

      // Which line the "+" landed on is the library's business, not the test's:
      // asked rather than assumed, or this edits a line nothing points at and the
      // check passes for the wrong reason.
      const before = await servedComment()
      const at = before?.start ?? 0
      check(
        '  anchored on the line the server also reports',
        at > 0 && before?.anchor[0] === original[at - 1],
        JSON.stringify(before),
      )
      if (at === 0) return

      // That line and only that line: the others are the control.
      stage(original.map((line, index) => (index === at - 1 ? 'const renamed = 99' : line)))
      await page.keyboard.press('r')
      await until(page, `document.querySelectorAll('.comment.stale').length === 1`)

      check('rewriting the commented line flags it', (await count('.comment.stale')) === 1)
      // With the flag stripped of context, a stale comment is an instruction about
      // code nobody can point to any more.
      const wasLine = await page.evaluate(
        `(document.querySelector('.comment-anchor') || {}).textContent || null`,
      )
      check('  showing what the line used to say', wasLine === original[at - 1], String(wasLine))
      // Changed lines never imply that the comment was resolved.
      const label = await page.evaluate(
        `[...document.querySelectorAll('.comment header button')].map((b) => b.textContent.trim()).join(',')`,
      )
      check(
        '  and labels deletion honestly',
        String(label).includes('Delete') && !String(label).includes('Done'),
        String(label),
      )

      // Put the line back: the flag is computed on read, never written, so it
      // clears on its own rather than needing to be undone.
      stage(original)
      await page.keyboard.press('r')
      await until(page, `document.querySelectorAll('.comment.stale').length === 0`)
      check('restoring the line clears the flag', (await count('.comment.stale')) === 0)
      check('  and the comment is still there', (await count('.comment')) === 1)

      await page.evaluate(clickButton('Delete'))
      await comments(0)
      await settled(page)
    } finally {
      // Whatever happened above, the next suite gets the tree it expects.
      git('reset', '-q')
      rmSync(scratch, { force: true })
    }
  },
} satisfies Suite
