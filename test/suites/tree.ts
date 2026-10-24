import {
  allTreeRows,
  openPicker,
  pickerShows,
  poll,
  titlebar,
  waitForRows,
  TREE_ROWS,
  TREE_SCROLLER,
  type Suite,
} from '../harness.ts'

const ROW_HEIGHT = 24

export default {
  name: 'tree',
  async run({ page, load }, check) {
    await load()

    const rows = () =>
      page.evaluate(TREE_ROWS) as Promise<{
        rows: {
          name: string
          path: string
          kind: string
          status: string | null
          open: boolean
          decoration: string
        }[]
        dirs: { path: string; open: boolean }[]
        files: { name: string; path: string; status: string | null; decoration: string }[]
        selected: { name: string }[]
        icons: number
      }>

    const clickHead = (label: 'Collapse all' | 'Expand all') =>
      page.click(`.sidebar-head button[title="${label}"]`)

    const start = await rows()
    check('the tree renders rows', start.rows.length > 0, `${start.rows.length} rows`)
    check('rows carry icons', start.icons > 0, `${start.icons} svg nodes`)

    // Status comes from `git diff --name-status`, not from a default. The
    // fixture contains one of each on purpose.
    const statuses = new Set(start.files.map((f) => f.status))
    check(
      'every file row carries a git status',
      start.files.length > 0 && start.files.every((f) => f.status),
      [...statuses].join(', '),
    )
    const everything = await allTreeRows(page)
    const everyFile = everything.filter((r) => r.kind === 'file')
    const kinds = new Set(everyFile.map((r) => r.status))
    check(
      'added, deleted, modified and renamed are told apart',
      ['added', 'deleted', 'modified', 'renamed'].every((k) => kinds.has(k)),
      [...kinds].toSorted().join(', '),
    )

    // Virtualisation: the layout covers every row, the DOM holds a window.
    const claimed = (await titlebar(page)).files ?? NaN
    const geometry = (await page.evaluate(`(() => {
      const el = ${TREE_SCROLLER}
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
    })()`)) as { scrollHeight: number; clientHeight: number }
    const laidOut = Math.round(geometry.scrollHeight / ROW_HEIGHT)
    check('the whole tree is laid out', laidOut >= claimed, `${laidOut} rows for ${claimed} files`)
    check(
      'but only a window is mounted',
      start.rows.length < laidOut,
      `${start.rows.length} mounted of ${laidOut}`,
    )
    check(
      'every file is reachable by scrolling',
      everyFile.length === claimed,
      `${everyFile.length} distinct files seen, counter says ${claimed}`,
    )

    // Folding.
    await clickHead('Collapse all')
    await poll(rows, (shown) => shown.dirs.length > 0 && shown.dirs.every((dir) => !dir.open))
    const folded = await rows()
    check(
      'collapse all hides rows',
      folded.rows.length < start.rows.length,
      `${start.rows.length} -> ${folded.rows.length}`,
    )
    const summaries = folded.dirs.length
      ? (await rows()).rows.filter((r) => /\d+ files?$/.test(r.decoration))
      : []
    check(
      'folded directories say what they hide',
      summaries.length > 0,
      summaries.map((r) => r.decoration).join(' | '),
    )
    await clickHead('Expand all')
    const expanded = await poll(rows, (shown) => shown.rows.length === start.rows.length)
    check('expand all restores them', expanded.rows.length === start.rows.length)

    // The chain src/util/deep/nested is one row, not three — and only visible
    // while the tree is open, which is why this is not checked while folded.
    const flattened = everything.find((r) => r.kind === 'folder' && r.path.includes('util'))
    check(
      'single-child directories fold into one row',
      flattened?.path === 'src/util/deep/nested/',
      flattened?.path,
    )

    // j has to reveal what it selects, not select something invisible.
    await clickHead('Collapse all')
    await poll(rows, (shown) => shown.dirs.length > 0 && shown.dirs.every((dir) => !dir.open))
    const closed = await rows()
    let revealed = closed
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('j')
      revealed = await poll(rows, (shown) => shown.rows.length > closed.rows.length, 1_000)
      if (revealed.rows.length > closed.rows.length) break
    }
    check(
      'j selects a file',
      revealed.selected.length === 1,
      `${revealed.selected.length} selected`,
    )
    check(
      '  and unfolds the tree to show it',
      revealed.rows.length > closed.rows.length,
      `${closed.rows.length} -> ${revealed.rows.length}`,
    )

    // Reviewing another revision rebuilds the tree — the only path that reaches
    // resetPaths, since an identical file list is reused as is.
    await clickHead('Collapse all')
    await poll(rows, (shown) => shown.dirs.length > 0 && shown.dirs.every((dir) => !dir.open))
    const beforeSwitch = await rows()
    const wasFolded = new Set(beforeSwitch.dirs.filter((d) => !d.open).map((d) => d.path))

    await openPicker(page, 't')
    await page.keyboard.type('other')
    await pickerShows(page, 'other')
    await page.keyboard.press('Enter')
    await waitForRows(page)

    // The rebuilt tree restores its folds as it mounts.
    const afterSwitch = await poll(rows, (shown) => {
      const shared = shown.dirs.filter((d) => wasFolded.has(d.path))
      return shared.length > 0 && shared.every((d) => !d.open)
    })
    const shared = afterSwitch.dirs.filter((d) => wasFolded.has(d.path))
    const reopened = shared.filter((d) => d.open)
    check(
      'folds survive a rebuild of the tree',
      shared.length > 0 && reopened.length === 0,
      `${shared.length} shared, ${reopened.length} reopened`,
    )
  },
} satisfies Suite
