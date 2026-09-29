import { clickTreeRow, DIFF_SCROLLER, sleep, type Suite } from '../harness.ts'

export default {
  name: 'themes',
  async run({ page, load }, check) {
    await load()
    const picker = '.theme-picker select'
    const selected = () => page.$eval(picker, (el) => (el as HTMLSelectElement).value)
    check('defaults to GitHub Dark dimmed', (await selected()) === 'github-dimmed')

    const palettes = [
      ['catppuccin-frappe', 'rgb(48, 52, 70)', 'dark'],
      ['github-dark', 'rgb(13, 17, 23)', 'dark'],
      ['vscode-dark', 'rgb(30, 30, 30)', 'dark'],
      ['darcula', 'rgb(43, 43, 43)', 'dark'],
      ['catppuccin-mocha', 'rgb(30, 30, 46)', 'dark'],
      ['github-light', 'rgb(255, 255, 255)', 'light'],
      ['vscode-light', 'rgb(255, 255, 255)', 'light'],
      ['catppuccin-latte', 'rgb(239, 241, 245)', 'light'],
      ['solarized-light', 'rgb(253, 246, 227)', 'light'],
      ['github-dimmed', 'rgb(34, 39, 46)', 'dark'],
    ] as const
    const tokenColors = new Set<string>()
    for (const [theme, background, mode] of palettes) {
      await page.select(picker, theme)
      await page.waitForFunction(
        (bg) => {
          const diff = document.querySelector('diffs-container')
          return diff && getComputedStyle(diff).backgroundColor === bg
        },
        {},
        background,
      )
      // Syntax loading is asynchronous, including between two white palettes.
      await page.waitForNetworkIdle()
      const colors = await page.evaluate(() => {
        const tree = document.querySelector('file-tree-container')!
        const diff = document.querySelector('diffs-container')!
        const tokens = [...(diff.shadowRoot?.querySelectorAll('span[style]') ?? [])].slice(0, 30)
        return {
          body: getComputedStyle(document.body).backgroundColor,
          tree: getComputedStyle(tree).backgroundColor,
          token: tokens.map((token) => getComputedStyle(token).color).join(','),
          mode: getComputedStyle(document.documentElement).colorScheme,
          icons: tree.shadowRoot?.querySelectorAll('svg use').length ?? 0,
        }
      })
      check(
        `${theme} updates the app, tree and diff`,
        colors.body === background && colors.tree === background,
      )
      check(`${theme} keeps file icons`, colors.icons > 0)
      check(`${theme} sets the native color scheme`, colors.mode === mode)
      tokenColors.add(colors.token)
    }
    check(
      'each theme uses its own syntax colors',
      tokenColors.size === palettes.length && !tokenColors.has(''),
    )

    await clickTreeRow(page, 'web/components/Widget40.tsx')
    await sleep(500)
    const scroll = () => page.evaluate(`${DIFF_SCROLLER}.scrollTop`) as Promise<number>
    const before = await scroll()
    await page.select(picker, 'catppuccin-latte')
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
        (el) => getComputedStyle(el).backgroundColor === 'rgb(239, 241, 245)',
      ),
    )
    await page.keyboard.press('Escape')
    await load()
    check('light theme survives a reload', (await selected()) === 'catppuccin-latte')
    check(
      'native light controls survive a reload',
      (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) ===
        'light',
    )

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
