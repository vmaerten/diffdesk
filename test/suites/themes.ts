import type { ElementHandle } from 'puppeteer-core'

import { clickTreeRow, command, DIFF_SCROLLER, frames, poll, type Suite } from '../harness.ts'

/** The review's syntax colours, not those of the Settings preview. */
const TOKENS = `[...(document.querySelector('.diff diffs-container')?.shadowRoot
  ?.querySelectorAll('span[style]') ?? [])].slice(0, 30).map((t) => getComputedStyle(t).color).join(',')`

export default {
  name: 'themes',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })

    const openSettings = async () => {
      await command(page, 'settings')
      await page.waitForSelector('.settings-sheet[open]')
    }
    const closeSettings = async () => {
      await page.click('.settings-sheet footer button')
      await page.waitForSelector('.settings-sheet:not([open])')
    }
    const appearance = (choice: 'Light' | 'Dark') =>
      page.evaluate(
        (label) =>
          [...document.querySelectorAll<HTMLButtonElement>('.appearance-choices button')]
            .find((button) => button.textContent?.trim() === label)
            ?.click(),
        choice,
      )
    const themeSelect = async (which: 'Light' | 'Dark') =>
      (
        await page.evaluateHandle(
          (name) =>
            [...document.querySelectorAll('.settings-sheet label.settings-field')]
              .find((field) => field.textContent?.startsWith(`${name} syntax theme`))
              ?.querySelector('select'),
          which,
        )
      ).asElement() as ElementHandle<HTMLSelectElement>
    const tokens = () => page.evaluate(TOKENS) as Promise<string>
    /** A value once two readings a couple of frames apart agree: a repaint spreads over frames. */
    const steady = async <T>(read: () => Promise<T>, ready: (value: T) => boolean = () => true) => {
      let previous = await read()
      return poll(
        async () => {
          await frames(page)
          const value = await read()
          const settled = value === previous ? value : undefined
          previous = value
          return settled
        },
        (value) => value !== undefined && ready(value),
      ) as Promise<T>
    }
    const savedSettings = async () =>
      JSON.parse(
        ((await page.evaluate(
          () =>
            (window as unknown as { desktopFixture: { settings: string } }).desktopFixture.settings,
        )) as string) || '{}',
      ) as { appearance?: string; light?: string; dark?: string }
    /** Wait for the syntax colours to move away from `previous`, then settle. */
    const repainted = async (previous: string) => {
      await page.waitForFunction(`(${TOKENS}) !== ${JSON.stringify(previous)}`, { timeout: 15_000 })
      await page.waitForNetworkIdle()
      return steady(tokens)
    }

    // Each step changes the active theme, so each one has new colours to wait for.
    // Headless Chrome reports a dark system, whose default is GitHub Dark dimmed.
    const steps = [
      ['Light', 'github-light'],
      ['Light', 'vscode-light'],
      ['Light', 'catppuccin-latte'],
      ['Light', 'solarized-light'],
      ['Dark', 'github-dimmed'],
      ['Dark', 'catppuccin-frappe'],
      ['Dark', 'github-dark'],
      ['Dark', 'vscode-dark'],
      ['Dark', 'darcula'],
      ['Dark', 'catppuccin-mocha'],
    ] as const
    await openSettings()
    let current = await tokens()
    let mode: 'Light' | 'Dark' | null = null
    const tokenColors = new Set<string>()
    for (const [wanted, theme] of steps) {
      if (wanted !== mode) {
        mode = wanted
        await appearance(mode)
      }
      const select = await themeSelect(mode)
      if ((await select.evaluate((el) => el.value)) !== theme) await select.select(theme)
      current = await repainted(current)
      const state = await page.evaluate(() => ({
        scheme: getComputedStyle(document.documentElement).colorScheme,
        icons:
          document.querySelector('file-tree-container')?.shadowRoot?.querySelectorAll('svg use')
            .length ?? 0,
      }))
      check(`${theme} keeps file icons`, state.icons > 0)
      check(`${theme} sets the native color scheme`, state.scheme === mode.toLowerCase())
      tokenColors.add(current)
    }
    check(
      'each theme uses its own syntax colors',
      tokenColors.size === steps.length && !tokenColors.has(''),
      `${tokenColors.size} distinct of ${steps.length}`,
    )
    const chosen = await poll(
      savedSettings,
      (saved) =>
        saved.appearance === 'dark' &&
        saved.light === 'solarized-light' &&
        saved.dark === 'catppuccin-mocha',
    )
    check(
      'the choice reaches the native side',
      chosen.appearance === 'dark' &&
        chosen.light === 'solarized-light' &&
        chosen.dark === 'catppuccin-mocha',
      JSON.stringify(chosen),
    )
    await closeSettings()

    await clickTreeRow(page, 'web/components/Widget40.tsx')
    const scroll = () => page.evaluate(`${DIFF_SCROLLER}.scrollTop`) as Promise<number>
    const before = await steady(scroll, (top) => top > 0)
    await openSettings()
    await (await themeSelect('Dark')).select('github-dark')
    await repainted(current)
    await closeSettings()
    check(
      'switching keeps the reading position',
      before > 0 && Math.abs((await scroll()) - before) < 2,
      `${before} -> ${await scroll()}`,
    )
    // Read at the top, where the reloaded review opens.
    await page.evaluate(`${DIFF_SCROLLER}.scrollTop = 0`)
    await steady(scroll, (top) => top === 0)
    const chosenTheme = await steady(tokens, (colors) => colors !== '')

    await poll(savedSettings, (saved) => saved.dark === 'github-dark')
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    await page.waitForNetworkIdle()
    check('the theme survives a reload', (await tokens()) === chosenTheme)
    check(
      '  with its native color scheme',
      (await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)) ===
        'dark',
    )
  },
} satisfies Suite
