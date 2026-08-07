import { allTreeRows, sleep, type Suite } from '../harness.ts'

export default {
  name: 'viewed',
  async run({ page, load }, check) {
    const ready = async () => {
      await load()
      // File headers render asynchronously (worker pool + Shiki), so wait for
      // the control itself rather than for a duration.
      await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    }
    await ready()

    const counter = () =>
      page.evaluate(
        `document.querySelector('.sidebar-head span')?.textContent?.trim() ?? null`,
      ) as Promise<string | null>
    const bar = () =>
      page.evaluate(
        `document.querySelector('.viewed-bar')?.textContent?.trim() ?? null`,
      ) as Promise<string | null>
    // The tick can be on a row well below the fold, so the whole tree is walked.
    const ticked = async () => (await allTreeRows(page)).filter((r) => r.decoration.includes('✓'))

    check('starts with nothing viewed', (await ticked()).length === 0, (await counter()) ?? '')
    const controls = (await page.evaluate(
      `document.querySelectorAll('.viewed-toggle input').length`,
    )) as number
    check('files carry a Viewed control', controls > 0, `${controls} headers rendered`)

    await page.evaluate(`document.querySelector('.viewed-toggle input').click()`)
    await sleep(1200)
    const marked = await ticked()
    check(
      'marking updates the counter',
      (await counter())?.includes('1/') === true,
      (await counter()) ?? '',
    )
    check('  and ticks the row in the tree', marked.length === 1, marked[0]?.path)
    check('  and a bar reports the hidden file', Boolean(await bar()), (await bar()) ?? '')

    // The decisive one: the tick lives in .git/ghl/state.json, not in memory.
    await ready()
    const reloaded = await ticked()
    check('viewed state survives a reload', reloaded.length === 1, (await counter()) ?? '')

    await page.keyboard.press('v')
    await sleep(1200)
    check('v marks the active file', (await ticked()).length === 2, (await counter()) ?? '')

    // Clicking a viewed row brings the file back rather than jumping to nothing.
    const restore = (await ticked())[0]?.path ?? ''
    await page.evaluate(`(() => {
      const root = document.querySelector('file-tree-container').shadowRoot
      root.querySelector('[data-item-path="' + ${JSON.stringify(restore)} + '"]')?.click()
    })()`)
    await sleep(1200)
    check('clicking a viewed file restores it', (await ticked()).length === 1, restore)

    await page.evaluate(
      `[...document.querySelectorAll('.sidebar-head button')].find((b) => b.textContent === 'Reset').click()`,
    )
    await sleep(1200)
    await ready()
    check('reset clears the state for good', (await ticked()).length === 0)
  },
} satisfies Suite
