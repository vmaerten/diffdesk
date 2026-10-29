import {
  openOptions,
  openPicker,
  pickerShows,
  titlebar,
  titlebarWhen,
  type Suite,
} from '../harness.ts'

export default {
  name: 'pickers',
  async run({ page, load, url }, check) {
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

    // The base is text in the title bar: a click meant for the reviewed branch
    // used to land on it and change the base instead.
    await page.click('.capsule-base')
    check('clicking the base opens nothing', (await page.$('.picker-input')) === null)

    // Options closes like a menu: Escape hands the focus back to its button,
    // and another popover replaces it.
    await openOptions(page)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.options-popover', { hidden: true, timeout: 5_000 })
    check(
      'escape closes Options and focuses its button',
      await page.evaluate(() => document.activeElement?.getAttribute('title') === 'Diff options'),
    )
    await openOptions(page)
    await openPicker(page, 'b')
    check('opening a picker closes Options', (await page.$('.options-popover')) === null)
    await page.keyboard.press('Escape')
    await page.waitForSelector('.picker-input', { hidden: true })

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

    // It opens on the current base, not on the newest branch: Enter keeps it.
    await openPicker(page, 'b')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.picker-input', { hidden: true })
    const kept = await shown()
    check(
      'Enter on a fresh picker keeps the base',
      kept.base === 'main' && !kept.search.includes('base='),
      `${kept.base} ${kept.search}`,
    )

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

    check(
      '  for this review only',
      rebased.search.includes('base=release') &&
        rebased.notes.join(' ').includes('chosen for this review'),
      `${rebased.search} | ${rebased.notes.join(' | ')}`,
    )

    // Nothing is written to the repository: the next review resolves its own.
    await load()
    const next = await shown()
    check('the next review has the automatic base again', next.base === 'main', next.base ?? '')

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
    check('  in the URL', overridden.search.includes('base=release'), overridden.search)

    await openPicker(page, 'b')
    await page.keyboard.type('automatic')
    await pickerShows(page, 'automatic')
    await page.keyboard.press('Enter')
    const automatic = await titlebarWhen(
      page,
      (state) => !state.search.includes('base=') && state.base === 'main',
    )
    check('the automatic base drops the choice', automatic.base === 'main', automatic.base ?? '')

    // Reviewing another branch resolves its base again.
    await load('?target=feature&base=release')
    await openPicker(page, 't')
    await page.keyboard.type('other')
    await pickerShows(page, 'other')
    await page.keyboard.press('Enter')
    const switched = await titlebarWhen(
      page,
      (state) => state.target === 'other' && state.base === 'main',
    )
    check(
      'another branch drops the chosen base',
      switched.base === 'main' && !switched.search.includes('base='),
      `${switched.base} ${switched.search}`,
    )

    // A lower stack layer reviewed against the one above it: the base already
    // holds the whole branch, which is what a mistaken pick looked like.
    // Not `load`: an empty review has no file tree to wait for.
    await page.goto(url('?target=stack/a&base=stack/b'), { waitUntil: 'networkidle0' })
    await page.waitForSelector('.message button')
    check(
      'a base that already holds the target says so',
      (await page.$eval('.message', (el) => el.textContent ?? '')).includes(
        'is already part of the base',
      ),
    )
    await page.click('.message button')
    const restored = await titlebarWhen(
      page,
      (state) => !state.search.includes('base=') && state.base === 'main',
    )
    check('  and offers the automatic base', restored.base === 'main', restored.base ?? '')
  },
} satisfies Suite
