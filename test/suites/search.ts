import { DIFF_ON_SCREEN, sleep, type Suite } from '../harness.ts'

export default {
  name: 'search',
  async run({ page, load }, check) {
    await load()

    // Widget44 is near the end of a virtualised pane and does not exist in the
    // initial DOM. Native browser find cannot reach this line.
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, bubbles: true, cancelable: true
    }))`)
    await page.waitForSelector('.diff-search:not([hidden]) .diff-search-input')
    await page.type('.diff-search-input', 'widget44_27')
    await sleep(800)

    const count = (await page.$eval('.diff-search-count', (element) => element.textContent)) ?? ''
    check('search indexes lines outside the virtual window', count.trim() === '1/1', count.trim())

    const onScreen = (await page.evaluate(DIFF_ON_SCREEN)) as string[]
    check(
      'a search result scrolls its file into view',
      onScreen.some((name) => name.includes('Widget44.tsx')),
      onScreen.join(' | '),
    )

    const selected = (await page.evaluate(`(() => {
      for (const host of document.querySelectorAll('.diff diffs-container')) {
        const lines = host.shadowRoot?.querySelectorAll('[data-selected-line]') ?? []
        const text = [...lines].map((line) => line.textContent ?? '').join(' ')
        if (text) return text
      }
      return ''
    })()`)) as string
    check('the matching line is highlighted', selected.includes('widget44_27'), selected.trim())

    await page.keyboard.press('Escape')
    const closed = await page.$eval('.diff-search', (element) => element.hasAttribute('hidden'))
    check('Escape closes diff search', closed)
  },
} satisfies Suite
