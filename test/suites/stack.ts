import { sleep, topbar, waitForRows, type Suite, type TopbarState } from '../harness.ts'

/**
 * The fixture stacks `stack/a` (2 files) on `main`, then `stack/b` (1 file) on
 * `stack/a`. Counting files is what separates "this layer" from "everything
 * since the trunk" — a chain rendered correctly but diffed against the trunk
 * would pass every check about the strip itself.
 */
const names = (state: TopbarState) => state.layers.map((l) => l.name).join(', ')

const current = (state: TopbarState) =>
  state.layers
    .filter((l) => l.current)
    .map((l) => l.name)
    .join(', ')

export default {
  name: 'stack',
  async run({ page, load }, check) {
    const shown = () => topbar(page)

    await load('?target=stack%2Fb')
    const top = await shown()

    check('the whole chain is shown', top.trunk === 'main', top.trunk ?? '(no strip)')
    check('  bottom to top, in order', names(top) === 'stack/a, stack/b', names(top))
    check('  with the reviewed layer marked', current(top) === 'stack/b', current(top))
    check(
      '  and a PR number only where there is one',
      top.layers[0]?.pr === null && top.layers[1]?.pr === '#42',
      `${top.layers[0]?.pr} / ${top.layers[1]?.pr}`,
    )

    // The whole point: the base is the layer below, not the trunk.
    check('the base is the layer below', top.base === 'stack/a', top.base ?? '')
    check(
      '  and says it came from the stack',
      top.notes.join(' ').includes('stack'),
      top.notes.join(' | '),
    )
    check('  so only that layer is in the diff', top.files === '1 files', top.files ?? '')

    // Clicking a layer changes what is reviewed; the base follows on its own.
    await page.evaluate(
      `[...document.querySelectorAll('.stack-layer')]
        .find((e) => e.querySelector('.stack-name')?.textContent?.trim() === 'stack/a')
        ?.querySelector('.stack-name').click()`,
    )
    await waitForRows(page)
    await sleep(2500)
    const bottom = await shown()

    check('clicking a layer reviews it', bottom.target === 'stack/a', bottom.target ?? '')
    check('  its base is the trunk', bottom.base === 'main', bottom.base ?? '')
    check('  and the diff is that layer', bottom.files === '2 files', bottom.files ?? '')
    check('  carried in the URL', bottom.search.includes('stack%2Fa'), bottom.search)
    check('  and the strip follows the move', current(bottom) === 'stack/a', current(bottom))

    // A merged, pruned layer is part of the story but not a base: `stack/c` has
    // to fall through it to the trunk rather than diff against nothing.
    await load('?target=stack%2Fc')
    const above = await shown()

    check(
      'a merged layer is still shown',
      above.layers[0]?.name === 'stack/gone' && above.layers[0]?.merged === true,
      `${above.layers[0]?.name} merged=${above.layers[0]?.merged}`,
    )
    check('  but cannot be opened', above.layers[0]?.gone === true, `${above.layers[0]?.gone}`)
    check(
      '  and the layer above falls through to the trunk',
      above.base === 'main',
      above.base ?? '',
    )
    check('  with only its own files in the diff', above.files === '3 files', above.files ?? '')

    // A branch in no stack must be left exactly as it was: no strip, and the
    // base still guessed as the trunk. `other` rather than the suites' usual
    // `feature`: the fixture is shared, and the pickers suite remembers a base
    // for `feature` in .git/config — which would answer this check instead.
    await load('?target=other')
    const unstacked = await shown()
    check('a branch in no stack shows no chain', unstacked.trunk === null, unstacked.trunk ?? '')
    check('  and keeps the guessed base', unstacked.base === 'main', unstacked.base ?? '')
  },
} satisfies Suite
