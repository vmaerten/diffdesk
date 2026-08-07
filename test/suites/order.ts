import { allDiffFiles, allTreeRows, type Suite } from '../harness.ts'

/**
 * The tree and the diff must list the same files in the same order.
 *
 * `fileOrder.ts` reproduces the tree's rule rather than replacing it — the
 * library's own `sort` option is not called on siblings alone, and feeding it a
 * sibling rule reorders the tree into something neither pane wanted. A copy of
 * someone else's ordering is a copy that can drift, so it is compared row by
 * row here: the last drift was `Widget1, Widget10, Widget11` against `Widget1,
 * Widget2, Widget3`, which only parts company at the tenth file.
 */
export default {
  name: 'order',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })

    // Both panes virtualise, so both have to be walked end to end.
    const leaves = (await allTreeRows(page)).map((r) => r.path).filter((p) => !p.endsWith('/'))
    const diff = (await allDiffFiles(page)).map((f) => f.name)

    check(
      'the tree lists every file in the diff',
      leaves.length === diff.length,
      `${leaves.length} vs ${diff.length}`,
    )

    // By basename: the diff pane's title is not always the full path.
    const first = leaves.findIndex(
      (path, i) => !(diff[i] ?? '').includes(path.split('/').at(-1) ?? ''),
    )
    check(
      'and in the same order',
      first === -1,
      first === -1
        ? `${leaves.length} files`
        : `row ${first}: tree ${leaves[first]}, diff ${diff[first]}`,
    )

    // Grouping is the point: a file at the root sorts after every directory,
    // where patch order put it first. Named by shape, not by filename — the
    // suites share a fixture, and an earlier one may have moved the base.
    const last = leaves.at(-1) ?? ''
    check('a root file sorts last, as in the tree', last !== '' && !last.includes('/'), last)
  },
} satisfies Suite
