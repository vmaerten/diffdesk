import { frames, poll, TREE_ROWS, type Suite } from '../harness.ts'

const MIN = 180
const DEFAULT = 272
const MAX = 700

export default {
  name: 'resize',
  async run({ page, load }, check) {
    await load()

    const widths = () =>
      page.evaluate(`(() => {
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
        const diff = document.querySelector('.diff')?.getBoundingClientRect()
        return {
          sidebar: Math.round(sidebar.width),
          diff: diff ? Math.round(diff.width) : 0,
          stored: localStorage.getItem('diffdesk.sidebarWidth'),
        }
      })()`) as Promise<{ sidebar: number; diff: number; stored: string | null }>

    const handle = () =>
      page.evaluate(`(() => {
        const r = document.querySelector('.resizer').getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + 200 }
      })()`) as Promise<{ x: number; y: number }>

    /** Several steps, so a handler that only reads the final position still fails. */
    const drag = async (dx: number) => {
      const from = await handle()
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      for (let i = 1; i <= 5; i++) {
        await page.mouse.move(from.x + (dx * i) / 5, from.y)
        await frames(page)
      }
      await page.mouse.up()
      await frames(page)
    }

    /**
     * `count: 2` and not two `click()` calls: CDP takes the click count from the
     * event rather than from timing, so two separate clicks both arrive with
     * detail 1 and the browser never synthesises a dblclick.
     */
    const doubleClick = async () => {
      const at = await handle()
      await page.mouse.move(at.x, at.y)
      await page.mouse.click(at.x, at.y, { count: 2 })
      await frames(page)
    }

    const start = await widths()
    check('the sidebar starts at its default', start.sidebar === DEFAULT, `${start.sidebar}px`)

    await drag(200)
    const wider = await widths()
    check('dragging right widens it', wider.sidebar === DEFAULT + 200, `${wider.sidebar}px`)
    check('  and the diff gives up the room', wider.diff < start.diff, `${wider.diff}px`)
    const stillThere = (await page.evaluate(TREE_ROWS)) as { rows: unknown[] }
    check('  and the tree still renders', stillThere.rows.length > 0)

    await drag(-1000)
    check(
      'it stops at the minimum',
      (await widths()).sidebar === MIN,
      `${(await widths()).sidebar}px`,
    )

    await drag(2000)
    const maxed = await widths()
    check(
      'and at the maximum, leaving room for the diff',
      maxed.sidebar === MAX && maxed.diff > 400,
      `sidebar ${maxed.sidebar}px, diff ${maxed.diff}px`,
    )
    check('the width is persisted', maxed.stored === String(MAX), `stored ${maxed.stored}`)

    await load()
    check('and survives a reload', (await widths()).sidebar === MAX)

    await doubleClick()
    const reset = await widths()
    check('double-click resets to the default', reset.sidebar === DEFAULT, `${reset.sidebar}px`)

    await page.focus('.resizer')
    await page.keyboard.press('ArrowRight')
    const nudged = await poll(widths, (width) => width.sidebar === DEFAULT + 10)
    check('arrow keys nudge it', nudged.sidebar === DEFAULT + 10, `${nudged.sidebar}px`)
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    const further = await poll(widths, (width) => width.sidebar === DEFAULT - 40)
    check('shift moves further', further.sidebar === DEFAULT - 40, `${further.sidebar}px`)

    // The divider must not swallow the keys the rest of the UI listens for.
    await page.keyboard.press('j')
    const selected = await poll(
      () => page.evaluate(TREE_ROWS) as Promise<{ selected: unknown[] }>,
      (tree) => tree.selected.length === 1,
    )
    check('j still works with the divider focused', selected.selected.length === 1)

    await page.evaluate(`localStorage.removeItem('diffdesk.sidebarWidth')`)
  },
} satisfies Suite
