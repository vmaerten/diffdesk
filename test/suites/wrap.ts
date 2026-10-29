import type { Page } from 'puppeteer-core'

import type { Suite } from '../harness.ts'

/** The overflow of every rendered file, as the library marks its code. */
const overflows = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.diff diffs-container')].flatMap((host) =>
      [...(host.shadowRoot?.querySelectorAll('pre[data-overflow]') ?? [])].map((pre) =>
        pre.getAttribute('data-overflow'),
      ),
    ),
  )
const allAre = (page: Page, overflow: string) =>
  page.waitForFunction(
    (expected) => {
      const found = [...document.querySelectorAll('.diff diffs-container')].flatMap((host) => [
        ...(host.shadowRoot?.querySelectorAll('pre[data-overflow]') ?? []),
      ])
      return (
        found.length > 0 && found.every((pre) => pre.getAttribute('data-overflow') === expected)
      )
    },
    { timeout: 5_000 },
    overflow,
  )
const optionZ = async (page: Page) => {
  await page.keyboard.down('Alt')
  await page.keyboard.press('KeyZ')
  await page.keyboard.up('Alt')
}
const storedWrap = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        (window as unknown as { desktopFixture: { settings: string } }).desktopFixture.settings ||
          '{}',
      ).wrapLines as boolean | undefined,
  )

export default {
  name: 'wrap',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    const initial = await overflows(page)
    check(
      'long lines scroll by default',
      initial.length > 0 && initial.every((overflow) => overflow === 'scroll'),
    )

    await page.focus('.diff')
    await optionZ(page)
    await allAre(page, 'wrap')
    check('⌥Z wraps every file', true)
    check('the choice is saved with the settings', (await storedWrap(page)) === true)

    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    await allAre(page, 'wrap')
    check('wrapping survives a reload', true)

    // Option+Z types a character in a field: the field keeps it.
    await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    )
    await page.waitForSelector('.diff-search:not([hidden]) .diff-search-input')
    await optionZ(page)
    check('⌥Z in a field leaves wrapping alone', (await storedWrap(page)) === true)
    await page.keyboard.press('Escape')

    await page.focus('.diff')
    await optionZ(page)
    await allAre(page, 'scroll')
    check('⌥Z again scrolls long lines', (await storedWrap(page)) === false)
  },
} satisfies Suite
