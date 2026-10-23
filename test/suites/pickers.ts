import { openPicker, pickerShows, titlebar, titlebarWhen, type Suite } from '../harness.ts'

export default {
  name: 'pickers',
  async run({ page, load }, check) {
    await load()

    const shown = () => titlebar(page)

    const items = () =>
      page.evaluate(
        `[...document.querySelectorAll('.picker-item .picker-name')].map((e) => e.textContent.trim())`,
      ) as Promise<string[]>

    const start = await shown()
    // The fixture leaves `main` checked out; reviewing `feature` must not need it.
    check('the reviewed revision is shown', start.target === 'feature', start.target ?? '')
    check('the base is guessed as the trunk', start.base === 'main', start.base ?? '')

    // Base picker.
    await openPicker(page, 'b')
    const offered = await items()
    check('b opens a picker listing the refs', offered.length >= 3, offered.join(', '))

    await page.keyboard.type('other')
    await pickerShows(page, 'other')
    const filtered = await items()
    check('typing filters the list', filtered.length < offered.length, filtered.join(', '))
    check('  and the match is relevant', filtered[0]?.includes('other') === true, filtered[0])

    await page.keyboard.press('Escape')
    await page.waitForSelector('.picker-input', { hidden: true })
    check('escape closes without picking', (await shown()).base === 'main')

    // `release` is an older commit on main, so the diff has to widen. `other`
    // forks from the same commit as `feature` and would change nothing — which
    // is exactly how a base picker that does not work could pass.
    await openPicker(page, 'b')
    await page.keyboard.type('release')
    await pickerShows(page, 'release')
    await page.keyboard.press('Enter')
    const rebased = await titlebarWhen(page, (state) => state.base === 'release')
    check('picking changes the base', rebased.base === 'release', rebased.base ?? '')
    check('  and the diff changes with it', rebased.files !== start.files, String(rebased.files))

    // Remembered in .git/config, so it has to survive a reload.
    await load()
    const remembered = await shown()
    check('the choice is remembered', remembered.base === 'release', remembered.base ?? '')
    check(
      '  and says where it came from',
      remembered.notes.join(' ').includes('remembered'),
      remembered.notes.join(' | '),
    )

    // Target picker.
    await openPicker(page, 't')
    const targets = await items()
    check(
      't offers the working tree explicitly',
      targets.some((t) => t.toLowerCase().includes('working tree')),
      targets.slice(0, 3).join(', '),
    )

    await page.keyboard.type('working tree')
    await pickerShows(page, 'working tree')
    await page.keyboard.press('Enter')
    const onCheckout = await titlebarWhen(page, (state) => state.target === 'main')
    check('picking it reviews the checkout', onCheckout.target === 'main', onCheckout.target ?? '')
    check(
      '  and drops target from the URL',
      !onCheckout.search.includes('target='),
      onCheckout.search,
    )

    await openPicker(page, 't')
    await page.keyboard.type('feature')
    await pickerShows(page, 'feature')
    await page.keyboard.press('Enter')
    const back = await titlebarWhen(page, (state) => state.target === 'feature')
    check('and back to a ref', back.target === 'feature', back.target ?? '')
    check(
      '  which warns the working tree is excluded',
      back.notes.join(' ').includes('excluded'),
      back.notes.join(' | '),
    )
    check('  and carries it in the URL', back.search.includes('target='), back.search)

    // A base forced from outside — which is how the CLI passes `--base` now —
    // must give way to a choice made here, in the session that makes it. It used
    // to be answered by the registry on every request, so the picker wrote to
    // `.git/config`, reported success, and changed nothing on screen.
    await load('?target=feature&base=other')
    const forced = await shown()
    check('a base given in the URL is honoured', forced.base === 'other', forced.base ?? '')

    await openPicker(page, 'b')
    await page.keyboard.type('release')
    await pickerShows(page, 'release')
    await page.keyboard.press('Enter')
    const overridden = await titlebarWhen(page, (state) => state.base === 'release')
    check(
      '  and picking another one takes effect at once',
      overridden.base === 'release',
      overridden.base ?? '',
    )
    check('  dropping it from the URL', !overridden.search.includes('base='), overridden.search)
  },
} satisfies Suite
