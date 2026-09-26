import { clickTreeRow, DIFF_SCROLLER, sleep, type Suite } from '../harness.ts'

export default {
  name: 'themes',
  async run({ page, load }, check) {
    await load()
    const picker = '.theme-picker select'
    const selected = () => page.$eval(picker, (el) => (el as HTMLSelectElement).value)
    check('defaults to GitHub Dark dimmed', (await selected()) === 'github-dimmed')

    const palettes = [
      ['catppuccin-frappe', 'rgb(48, 52, 70)'],
      ['github-dark', 'rgb(13, 17, 23)'],
      ['github-dimmed', 'rgb(34, 39, 46)'],
    ] as const
    const tokenColors = new Set<string>()
    for (const [theme, background] of palettes) {
      await page.select(picker, theme)
      await page.waitForFunction(
        (bg) => {
          const diff = document.querySelector('diffs-container')
          return diff && getComputedStyle(diff).backgroundColor === bg
        },
        {},
        background,
      )
      const colors = await page.evaluate(() => {
        const tree = document.querySelector('file-tree-container')!
        const diff = document.querySelector('diffs-container')!
        const token = diff.shadowRoot?.querySelector('span[style]')
        return {
          body: getComputedStyle(document.body).backgroundColor,
          tree: getComputedStyle(tree).backgroundColor,
          token: token ? getComputedStyle(token).color : '',
          icons: tree.shadowRoot?.querySelectorAll('svg use').length ?? 0,
        }
      })
      check(
        `${theme} updates the app, tree and diff`,
        colors.body === background && colors.tree === background,
      )
      check(`${theme} keeps file icons`, colors.icons > 0)
      tokenColors.add(colors.token)
    }
    check('each theme uses its own syntax colors', tokenColors.size === 3 && !tokenColors.has(''))

    await clickTreeRow(page, 'web/components/Widget40.tsx')
    await sleep(500)
    const scroll = () => page.evaluate(`${DIFF_SCROLLER}.scrollTop`) as Promise<number>
    const before = await scroll()
    await page.select(picker, 'catppuccin-frappe')
    await sleep(600)
    check(
      'switching keeps the reading position',
      before > 0 && Math.abs((await scroll()) - before) < 2,
    )
    await page.click('.comments-trigger')
    check(
      'comments panel follows the theme',
      await page.$eval(
        '.comments-panel',
        (el) => getComputedStyle(el).backgroundColor === 'rgb(48, 52, 70)',
      ),
    )
    await page.keyboard.press('Escape')
    await load()
    check('theme survives a reload', (await selected()) === 'catppuccin-frappe')

    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 844 })
      await sleep(200)
      check(
        `theme selector fits at ${width}px`,
        await page.$eval(picker, (el) => {
          const r = el.getBoundingClientRect()
          return (
            r.width > 100 &&
            r.left >= 0 &&
            r.right <= innerWidth &&
            document.documentElement.scrollWidth === innerWidth
          )
        }),
      )
    }

    await page.evaluate(() => localStorage.setItem('ghl.theme.v1', 'obsolete-theme'))
    await load()
    check('unknown saved themes fall back safely', (await selected()) === 'github-dimmed')
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error('Storage unavailable')
      }
    })
    await page.select(picker, 'catppuccin-frappe')
    check('theme remains usable without storage', (await selected()) === 'catppuccin-frappe')
    await page.evaluate(() => localStorage.removeItem('ghl.theme.v1'))
  },
} satisfies Suite
