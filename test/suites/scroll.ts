import {
  allTreeRows,
  DIFF_ON_SCREEN as ON_SCREEN,
  DIFF_SCROLLER as SCROLLER,
  frames,
  poll,
  titlebar,
  until,
  VIEWED_COUNT,
  type Suite,
} from '../harness.ts'

export default {
  name: 'scroll',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })

    const scrollable = (await page.evaluate(`Boolean(${SCROLLER})`)) as boolean
    check('the diff pane has a scroller of its own', scrollable)
    if (!scrollable) return

    const at = async (ratio: number) => {
      await page.evaluate(`(() => {
        const el = ${SCROLLER}
        el.scrollTop = (el.scrollHeight - el.clientHeight) * ${ratio}
      })()`)
      // The files that scrolled out leave the viewport at once; wait for the
      // window to mount the ones that scrolled in.
      await frames(page)
      return poll(
        () => page.evaluate(ON_SCREEN) as Promise<string[]>,
        (names) => names.length > 0,
      )
    }

    const top = await at(0)
    check('files are painted at the top', top.length > 0, top.slice(0, 2).join(' | '))

    const middle = await at(0.5)
    check(
      'scrolling changes which files are on screen',
      middle.length > 0 && middle.join() !== top.join(),
      `${top[0] ?? '?'} -> ${middle[0] ?? '?'}`,
    )

    // Scrolling moves the reader, so v marks a file they can see, not the first.
    await page.keyboard.press('v')
    await until(page, `(${VIEWED_COUNT})?.startsWith('1 of ')`)
    const ticked = (await allTreeRows(page)).find((row) => row.decoration.includes('✓'))?.path
    check(
      'v marks a file on screen after scrolling',
      !!ticked && middle.some((name) => ticked.endsWith(name) || name.endsWith(ticked)),
      `${ticked} among ${middle.join(' | ')}`,
    )
    await page.keyboard.press('v')
    await until(page, `(${VIEWED_COUNT})?.startsWith('0 of ')`)

    const bottom = await at(0.98)
    check(
      'and the end differs from the middle',
      bottom.length > 0 && bottom.join() !== middle.join(),
      bottom.slice(0, 2).join(' | '),
    )

    // The window must not have grown into the whole diff along the way.
    const mounted = (await page.evaluate(
      `${SCROLLER}.querySelectorAll('diffs-container').length`,
    )) as number
    const claimed = (await titlebar(page)).files ?? NaN
    check(
      'the diff stays virtualised to the end',
      mounted > 0 && mounted < claimed,
      `${mounted} files mounted of ${claimed}`,
    )
  },
} satisfies Suite
