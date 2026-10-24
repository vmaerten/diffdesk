import {
  DIFF_ON_SCREEN,
  DIFF_SCROLLER,
  frames,
  poll,
  settled,
  until,
  VIEWED_COUNT,
  type Suite,
} from '../harness.ts'

const SELECTED_TEXT = `(() => {
  for (const host of document.querySelectorAll('.diff diffs-container')) {
    const lines = host.shadowRoot?.querySelectorAll('[data-selected-line]') ?? []
    const text = [...lines].map((line) => line.textContent ?? '').join(' ')
    if (text) return text
  }
  return ''
})()`

const onMatch = (names: string[]) => names.some((name) => name.includes('Widget43.tsx'))

export default {
  name: 'search',
  async run({ page, load }, check) {
    await load()

    const gutter = (await page.evaluate(`(() => {
      for (const host of document.querySelectorAll('.diff diffs-container')) {
        const cell = host.shadowRoot?.querySelector('[data-gutter]')
        if (!cell) continue
        const rect = cell.getBoundingClientRect()
        if (rect.width) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      return null
    })()`)) as { x: number; y: number } | null
    check('a source line can be selected before searching', gutter !== null)
    if (!gutter) return
    await page.mouse.click(gutter.x, gutter.y)
    await page.waitForFunction(`(${SELECTED_TEXT}).length > 0`)
    const beforeSearch = await page.evaluate(SELECTED_TEXT)
    const beforeScroll = await page.evaluate(`${DIFF_SCROLLER}.scrollTop`)

    // Widget44 is near the end of a virtualised pane and does not exist in the
    // initial DOM. Native browser find cannot reach this line.
    // Delay the opening frame until typing has begun, as on a busy renderer.
    // Opening search must never select characters entered after the shortcut.
    await page.evaluate(`(() => {
      const original = window.requestAnimationFrame
      const cancel = window.cancelAnimationFrame
      const pending = new Map()
      let nextId = -1
      window.requestAnimationFrame = (callback) => {
        const id = nextId--
        pending.set(id, callback)
        return id
      }
      window.cancelAnimationFrame = (id) => {
        if (!pending.delete(id)) cancel.call(window, id)
      }
      window.resumeSearchFrame = () => {
        window.requestAnimationFrame = original
        window.cancelAnimationFrame = cancel
        for (const callback of pending.values()) callback(performance.now())
        delete window.resumeSearchFrame
      }
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', ctrlKey: true, bubbles: true, cancelable: true
      }))
    })()`)
    await page.waitForSelector('.diff-search:not([hidden]) .diff-search-input')
    await page.type('.diff-search-input', 'widget44_2')
    await page.evaluate('window.resumeSearchFrame()')
    await page.type('.diff-search-input', '7')

    const query = await page.$eval('input.diff-search-input', (input) => input.value)
    check(
      'opening search preserves characters typed before the next frame',
      query === 'widget44_27',
      query,
    )
    if (query !== 'widget44_27') return
    await page.waitForFunction(
      `document.querySelector('.diff-search-count')?.textContent.trim() === '1/1'`,
    )
    await page.waitForFunction(`(${SELECTED_TEXT}).includes('widget44_27')`)

    const count = (await page.$eval('.diff-search-count', (element) => element.textContent)) ?? ''
    check('search indexes lines outside the virtual window', count.trim() === '1/1', count.trim())

    const onScreen = (await page.evaluate(DIFF_ON_SCREEN)) as string[]
    check(
      'a search result scrolls its file into view',
      onScreen.some((name) => name.includes('Widget44.tsx')),
      onScreen.join(' | '),
    )

    const selected = (await page.evaluate(SELECTED_TEXT)) as string
    check('the matching line is highlighted', selected.includes('widget44_27'), selected.trim())

    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, bubbles: true, cancelable: true
    }))`)
    await page.keyboard.type('widget43_27')
    const replacement = await page.$eval('input.diff-search-input', (input) => input.value)
    check(
      'reopening search selects the existing query for replacement',
      replacement === 'widget43_27',
      replacement,
    )
    await page.waitForFunction(`(${SELECTED_TEXT}).includes('widget43_27')`)

    // Ticking Viewed elsewhere recomputes the matches; the pane stays put.
    await page.evaluate(`(() => {
      const scroller = ${DIFF_SCROLLER}
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }))
      scroller.scrollTop = 0
    })()`)
    await poll(
      () => page.evaluate(DIFF_ON_SCREEN) as Promise<string[]>,
      (names) => !onMatch(names),
    )
    await page.evaluate(`document.activeElement && document.activeElement.blur()`)
    await page.keyboard.press('v')
    await until(page, `(${VIEWED_COUNT})?.startsWith('1 of ')`)
    await settled(page)
    await frames(page)
    const afterTick = (await page.evaluate(DIFF_ON_SCREEN)) as string[]
    check(
      'ticking Viewed with search open leaves the pane where the reader put it',
      !onMatch(afterTick),
      afterTick.join(' | '),
    )
    await page.keyboard.press('v')
    await until(page, `(${VIEWED_COUNT})?.startsWith('0 of ')`)
    await page.focus('.diff-search-input')

    await page.keyboard.press('Escape')
    const closed = await page.$eval('.diff-search', (element) => element.hasAttribute('hidden'))
    check('Escape closes diff search', closed)

    // A reader's scroll cancels CodeView's pending search navigation. Setting
    // scrollTop alone can be overwritten by its next layout/measurement frame.
    await page.evaluate(`(() => {
      const scroller = ${DIFF_SCROLLER}
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }))
      scroller.scrollTop = ${beforeScroll}
    })()`)
    await page.waitForFunction(`(${SELECTED_TEXT}).length > 0`)
    check(
      'closing search restores the original source selection',
      (await page.evaluate(SELECTED_TEXT)) === beforeSearch,
    )
  },
} satisfies Suite
