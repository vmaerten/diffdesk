import { allTreeRows, openPicker, sleep, topbar, waitForRows, type Suite } from '../harness.ts'

/** The subjects the fixture's branch carries, newest first. */
const NEWEST = 'move things around'
const CORE = 'widen the core'

export default {
  name: 'commits',
  async run({ page, load }, check) {
    await load('?target=feature&base=feature%5E')
    await openPicker(page, 'l')
    const explicitBase = await page.evaluate(() =>
      [...document.querySelectorAll('.picker-item .picker-name')].map((item) =>
        item.textContent?.trim(),
      ),
    )
    check(
      'commit picker uses the explicit base of the displayed diff',
      explicitBase.length === 2 && explicitBase[0] === 'All commits' && explicitBase[1] === NEWEST,
      explicitBase.join(' | '),
    )
    await load('?target=feature')

    await openPicker(page, 'l')
    const listed = (await page.evaluate(
      `[...document.querySelectorAll('.picker-item .picker-name')].map((e) => e.textContent.trim())`,
    )) as string[]
    check(
      'l lists the commits of the range',
      listed.includes(NEWEST) && listed.includes(CORE) && listed.includes('grow the widgets'),
      listed.join(' | '),
    )
    // The first entry is the way back, then the branch's own commits newest
    // first — the order the picker promises before anything is typed.
    check('  with a way back to all of them first', listed[0] === 'All commits', listed[0])
    check('  and the newest commit above the rest', listed[1] === NEWEST, listed[1])

    await page.keyboard.type('widen')
    await sleep(400)
    await page.keyboard.press('Enter')
    await waitForRows(page)
    await sleep(1500)

    const state = await topbar(page)
    check('picking one shows that commit', state.search.includes('commit='), state.search)
    check(
      '  and says the base is not compared',
      state.notes.join(' | ').includes('not compared'),
      state.notes.join(' | '),
    )

    // Three files, where the branch as a whole changes fifty-odd: the commit's
    // own diff, not everything since the base.
    const narrowed = (await allTreeRows(page)).filter((r) => r.kind === 'file').map((r) => r.path)
    check(
      '  narrowing the files to the ones it touches',
      narrowed.length === 3 && narrowed.every((p) => p.startsWith('src/')),
      narrowed.join(', '),
    )

    await page.keyboard.press('v')
    await sleep(1200)
    const tickedHere = (await allTreeRows(page)).filter((r) => r.decoration.includes('✓'))
    check('a file can be marked read on a commit', tickedHere.length === 1, tickedHere[0]?.path)

    // The decisive one: ticks are keyed on the commit, so what was read there is
    // not counted as read of the branch.
    await openPicker(page, 'l')
    await page.keyboard.press('Enter')
    await waitForRows(page)
    await sleep(1500)
    const back = await topbar(page)
    check(
      'going back to all commits drops the parameter',
      !back.search.includes('commit='),
      back.search,
    )
    const tickedOnBranch = (await allTreeRows(page)).filter((r) => r.decoration.includes('✓'))
    check(
      '  and the branch view does not carry that tick',
      tickedOnBranch.length === 0,
      tickedOnBranch.map((r) => r.path).join(', ') || 'none',
    )

    await openPicker(page, 'l')
    await page.keyboard.type('widen')
    await sleep(400)
    await page.keyboard.press('Enter')
    await waitForRows(page)
    await sleep(1500)
    const tickedAgain = (await allTreeRows(page)).filter((r) => r.decoration.includes('✓'))
    check('  while the commit keeps it', tickedAgain.length === 1, tickedAgain[0]?.path)

    await openPicker(page, 't')
    await page.keyboard.type('working tree')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('commit'))
    check(
      'changing target clears the commit selected in the previous history',
      !(await topbar(page)).search.includes('commit='),
    )

    // A rebase, an amend: the sha is gone. Falling back in silence would leave
    // the reader believing they are still on that commit.
    await load('?target=feature&commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    const warnings = (await page.evaluate(
      `[...document.querySelectorAll('.warning')].map((e) => e.textContent.trim())`,
    )) as string[]
    check(
      'a sha that no longer resolves falls back to the range',
      (await topbar(page)).notes.join(' | ').includes('not compared') === false,
      (await topbar(page)).notes.join(' | '),
    )
    check(
      '  and says so rather than showing the branch under its name',
      warnings.some((w) => w.includes('no longer resolves')),
      warnings.join(' | ') || 'nothing',
    )
  },
} satisfies Suite
