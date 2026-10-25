import { command, poll, VIEWED_COUNT, type Suite } from '../harness.ts'

const OPEN = 'dialog.command-palette[open]'
const ITEMS = `[...document.querySelectorAll('.palette-item')].map((e) => ({
  label: e.querySelector('.palette-label').textContent,
  checked: e.getAttribute('aria-checked'),
  marked: [...e.querySelectorAll('.palette-label mark')].map((m) => m.textContent).join('|'),
}))`
const FOCUSED = `document.activeElement?.className ?? ''`

interface Item {
  label: string
  checked: string | null
  marked: string
}

export default {
  name: 'palette',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })

    const items = () => page.evaluate(ITEMS) as Promise<Item[]>
    const isOpen = async () => (await page.$(OPEN)) !== null
    const focused = () => page.evaluate(FOCUSED) as Promise<string>
    const open = async () => {
      await command(page, 'palette')
      await page.waitForSelector(`${OPEN} .palette-input`, { timeout: 5_000 })
    }
    /** Search the palette and wait until `label` comes first. */
    const search = async (text: string, label: string) => {
      await page.keyboard.type(text)
      return poll(items, (shown) => shown[0]?.label === label)
    }

    await open()
    check(
      'the palette opens with its search focused',
      (await focused()).includes('palette-input'),
      await focused(),
    )
    const offered = await items()
    const labels = offered.map((item) => item.label)
    check(
      'it lists the review and window commands',
      labels.includes('Split') && labels.includes('Keyboard Shortcuts'),
      labels.join(', '),
    )
    check(
      '  but not those that would do nothing here',
      !labels.includes('Choose Stack Layer…') && !labels.includes('Copy All Comments'),
    )
    const state = (label: string) => offered.find((item) => item.label === label)?.checked
    check(
      '  and checks the layout shown',
      state('Unified') === 'true' && state('Split') === 'false',
      `${state('Unified')} ${state('Split')}`,
    )

    const found = await search('splt', 'Split')
    check(
      'typing filters, marking the letters that matched',
      found[0]?.marked === 'Spl|t',
      JSON.stringify(found[0]),
    )
    await page.keyboard.press('Enter')
    const pressed = () =>
      page.evaluate(
        `document.querySelector('[aria-label="Diff layout"] [aria-pressed="true"]')?.textContent.trim()`,
      ) as Promise<string | undefined>
    check(
      'Enter runs the command and closes the palette',
      (await poll(pressed, (style) => style === 'Split')) === 'Split' && !(await isOpen()),
    )

    // The palette is gone before the command runs, or the picker it opens
    // would find the page inert and lose its focus.
    await open()
    await search('choose base', 'Choose Base…')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.picker-input', { timeout: 5_000 })
    check(
      'a picker opened from the palette takes the focus',
      (await focused()).includes('picker-input'),
      await focused(),
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector('.picker-input', { hidden: true })

    await open()
    await search('keyboard', 'Keyboard Shortcuts')
    await page.keyboard.press('Enter')
    check(
      'a window command reaches the window',
      (await page.waitForSelector('.shortcuts-sheet[open]', { timeout: 5_000 })) !== null,
    )
    await page.keyboard.press('Escape')
    await page.waitForSelector('.shortcuts-sheet[open]', { hidden: true })

    await open()
    await search('settings', 'Settings…')
    await page.keyboard.press('Enter')
    const opened = () => page.evaluate(`window.desktopFixture.settingsOpened`) as Promise<number>
    check('Settings… opens the Settings window', (await poll(opened, (n) => n === 1)) === 1)

    await open()
    await page.keyboard.press('Escape')
    check('Escape closes the palette', !(await isOpen()))
    const viewed = (await page.evaluate(VIEWED_COUNT)) as string | null
    await page.keyboard.press('v')
    const after = await poll(
      () => page.evaluate(VIEWED_COUNT) as Promise<string | null>,
      (count) => count !== viewed,
    )
    check('  and hands the review keys back', after !== viewed, `${viewed} → ${after}`)
  },
} satisfies Suite
