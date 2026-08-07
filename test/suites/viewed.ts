import {
  allDiffFiles,
  allTreeRows,
  clickTreeRow,
  DIFF_ON_SCREEN as ON_SCREEN,
  DIFF_SCROLLER as SCROLLER,
  sleep,
  type Suite,
} from '../harness.ts'

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
    // The tick can be on a row well below the fold, so the whole tree is walked.
    const ticked = async () => (await allTreeRows(page)).filter((r) => r.decoration.includes('✓'))

    check('starts with nothing viewed', (await ticked()).length === 0, (await counter()) ?? '')
    const controls = (await page.evaluate(
      `document.querySelectorAll('.viewed-toggle input').length`,
    )) as number
    check('files carry a Viewed control', controls > 0, `${controls} headers rendered`)

    const boxes = () =>
      page.evaluate(
        `[...document.querySelectorAll('.viewed-toggle input')].map((b) => b.checked)`,
      ) as Promise<boolean[]>

    await page.evaluate(`document.querySelector('.viewed-toggle input').click()`)
    await sleep(1200)
    const marked = await ticked()
    check(
      'marking updates the counter',
      (await counter())?.includes('1/') === true,
      (await counter()) ?? '',
    )
    check('  and ticks the row in the tree', marked.length === 1, marked[0]?.path)
    // The box itself, not only the counter: a header that never re-renders
    // leaves it unticked and its handler closed over a stale value, so the file
    // can never be un-viewed from there. The counter says nothing about that.
    check('  and the box shows it', (await boxes())[0] === true, JSON.stringify(await boxes()))
    // Folded, not gone. `collapsed` on its own is accepted and ignored: the pane
    // re-reads an item only when its `version` moves, so this stays expanded if
    // the version is not bumped alongside — silently, with nothing in the DOM to
    // say the flag was refused.
    const first = marked[0]?.path.split('/').at(-1) ?? ''
    const shut = (await allDiffFiles(page)).find((f) => f.name.includes(first))
    check('  and the file folds shut', shut?.spans === 0, `${shut?.spans ?? -1} coloured tokens`)

    await page.evaluate(`document.querySelector('.viewed-toggle input').click()`)
    await sleep(1200)
    check(
      'clicking the box again un-views it',
      (await ticked()).length === 0,
      (await counter()) ?? '',
    )
    check('  and the box clears', (await boxes())[0] === false, JSON.stringify(await boxes()))
    const reopened = (await allDiffFiles(page)).find((f) => f.name.includes(first))
    check(
      '  and the file opens again',
      (reopened?.spans ?? 0) > 0,
      `${reopened?.spans ?? -1} tokens`,
    )

    // Back to one viewed file, for the reload check below.
    await page.evaluate(`document.querySelector('.viewed-toggle input').click()`)
    await sleep(1200)

    // The decisive one: the tick lives in .git/ghl/state.json, not in memory.
    await ready()
    const reloaded = await ticked()
    check('viewed state survives a reload', reloaded.length === 1, (await counter()) ?? '')

    // After a reload the active file is the first one, which is the one just
    // marked — so `v` clears it rather than marking a second.
    await page.keyboard.press('v')
    await sleep(1200)
    check('v toggles the active file', (await ticked()).length === 0, (await counter()) ?? '')

    // Clicking a viewed row brings the file back, and takes the reader to it.
    //
    // Deliberately a file deep in the list. Restoring one near the top proves
    // nothing: the pane sits at the top to begin with, so it would be on screen
    // whether anything navigated or not — which is how this stayed green while
    // the click did nothing at all.
    const RESTORE = 'web/components/Widget40.tsx'
    const name = RESTORE.split('/').at(-1) ?? RESTORE
    const onScreen = async () => (await page.evaluate(ON_SCREEN)) as string[]

    const clicked = await clickTreeRow(page, RESTORE)
    await sleep(1200)
    check('the deep file has a row to click', clicked, RESTORE)
    check(
      'a deep file can be reached from the tree',
      (await onScreen()).some((n) => n.includes(name)),
    )

    await page.keyboard.press('v')
    await sleep(1200)
    // Read the position first: allDiffFiles walks the whole scroll and parks the
    // pane back at the top, so asking afterwards would measure the helper.
    const afterMark = await onScreen()
    check('  and marked viewed from there', (await ticked()).length === 1, (await counter()) ?? '')
    // Marking must not throw the reader back to the top: the neighbours it was
    // read among are what comes next.
    check(
      '  leaving the reader among its neighbours',
      afterMark.some((n) => n.includes('Widget')),
      afterMark.join(', ') || 'nothing on screen',
    )
    // As GitHub does it: the file stays in the list and folds shut. It used to
    // be dropped from the array, which rebuilt the pane's virtual window.
    const deep = (await allDiffFiles(page)).find((f) => f.name.includes(name))
    check('  and the file stays in the diff', Boolean(deep), RESTORE)
    check('  folded shut, not removed', deep?.spans === 0, `${deep?.spans ?? -1} coloured tokens`)

    // Away from it, so being on screen afterwards can only come from the click.
    await page.evaluate(`(() => { ${SCROLLER}.scrollTop = 0 })()`)
    await sleep(900)
    const away = await onScreen()
    check(
      '  with the pane scrolled elsewhere',
      !away.some((n) => n.includes(name)),
      away.join(', ') || 'nothing on screen',
    )

    await clickTreeRow(page, RESTORE)
    await sleep(1200)
    // The reported bug: this click did nothing at all.
    const shown = await onScreen()
    check(
      'clicking a viewed file scrolls to it',
      shown.some((n) => n.includes(name)),
      shown.join(', ') || 'nothing on screen',
    )
    check('  and it is still marked viewed', (await ticked()).length === 1, (await counter()) ?? '')

    await page.evaluate(
      `[...document.querySelectorAll('.sidebar-head button')].find((b) => b.textContent === 'Reset').click()`,
    )
    await sleep(1200)
    await ready()
    check('reset clears the state for good', (await ticked()).length === 0)
  },
} satisfies Suite
