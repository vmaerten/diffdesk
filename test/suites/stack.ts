import { settled, titlebar, titlebarWhen, type Suite, type TitlebarState } from '../harness.ts'

/**
 * The fixture stacks `stack/a` (2 files) on `main`, then `stack/b` (1 file) on
 * `stack/a`. Counting files is what separates "this layer" from "everything
 * since the trunk" — a chain rendered correctly but diffed against the trunk
 * would pass every check about the list itself.
 */
const names = (state: TitlebarState) => state.layers.map((l) => l.name).join(', ')

const current = (state: TitlebarState) =>
  state.layers
    .filter((l) => l.current)
    .map((l) => l.name)
    .join(', ')

export default {
  name: 'stack',
  async run({ page, load }, check) {
    const shown = () => titlebar(page)
    const opened = async () => {
      await page.keyboard.press('s')
      return titlebarWhen(page, (state) => state.layers.length > 0)
    }

    await load('?target=stack%2Fb')
    const closed = await shown()
    check('a stacked branch shows its layer', closed.stack === '2/2', closed.stack ?? '(no button)')
    check('  with the list closed', closed.layers.length === 0, names(closed))

    const top = await opened()
    check('s opens the whole stack', top.trunk === 'main', top.trunk ?? '(no list)')
    check('  top to bottom, in order', names(top) === 'stack/b, stack/a', names(top))
    check('  with the reviewed layer marked', current(top) === 'stack/b', current(top))
    check(
      '  and a PR number only where there is one',
      top.layers[0]?.pr === '#42' && top.layers[1]?.pr === null,
      `${top.layers[0]?.pr} / ${top.layers[1]?.pr}`,
    )
    const focused = await page.evaluate(
      () => (document.activeElement?.closest('.stack-row') as HTMLElement | null)?.dataset.branch,
    )
    check('  focused on the reviewed layer', focused === 'stack/b', String(focused))

    // The whole point: the base is the layer below, not the trunk.
    check('the base is the layer below', top.base === 'stack/a', top.base ?? '')
    check(
      '  and says it came from the stack',
      top.notes.join(' ').includes('stack'),
      top.notes.join(' | '),
    )
    check('  so only that layer is in the diff', top.files === 1, String(top.files))

    // Picking a layer changes what is reviewed; the base follows on its own.
    await page.click('.stack-row[data-branch="stack/a"] .stack-branch')
    const bottom = await titlebarWhen(
      page,
      (state) => state.target === 'stack/a' && state.files === 2 && state.stack === '1/2',
    )
    check('picking a layer reviews it', bottom.target === 'stack/a', bottom.target ?? '')
    check('  its base is the trunk', bottom.base === 'main', bottom.base ?? '')
    check('  and the diff is that layer', bottom.files === 2, String(bottom.files))
    check('  carried in the URL', bottom.search.includes('stack%2Fa'), bottom.search)
    check('  and the list closes', bottom.layers.length === 0, names(bottom))

    await page.keyboard.press(']')
    const up = await titlebarWhen(page, (state) => state.target === 'stack/b' && state.files === 1)
    check('] reviews the layer above', up.target === 'stack/b', up.target ?? '')
    await page.keyboard.press('[')
    const down = await titlebarWhen(
      page,
      (state) => state.target === 'stack/a' && state.files === 2,
    )
    check('[ the layer below', down.target === 'stack/a', down.target ?? '')

    // A merged, pruned layer is part of the story but not a base: `stack/c` has
    // to fall through it to the trunk rather than diff against nothing.
    await load('?target=stack%2Fc')
    const above = await opened()
    check(
      'a merged layer is still shown',
      above.layers[1]?.name === 'stack/gone' && above.layers[1]?.merged === true,
      `${above.layers[1]?.name} merged=${above.layers[1]?.merged}`,
    )
    check('  but cannot be opened', above.layers[1]?.gone === true, `${above.layers[1]?.gone}`)
    check(
      '  and the layer above falls through to the trunk',
      above.base === 'main',
      above.base ?? '',
    )
    check('  with only its own files in the diff', above.files === 3, String(above.files))

    await page.keyboard.press('Escape')
    const dismissed = await titlebarWhen(page, (state) => state.layers.length === 0)
    check('Escape closes the list', dismissed.layers.length === 0, names(dismissed))
    await page.keyboard.press('[')
    await settled(page)
    const kept = await shown()
    check('[ never lands on a pruned layer', kept.target === 'stack/c', kept.target ?? '')

    // A branch in no stack must be left exactly as it was: no button, and the
    // base still guessed as the trunk.
    await load('?target=other')
    const unstacked = await shown()
    check('a branch in no stack shows no stack', unstacked.stack === null, unstacked.stack ?? '')
    check('  and keeps the guessed base', unstacked.base === 'main', unstacked.base ?? '')
  },
} satisfies Suite
