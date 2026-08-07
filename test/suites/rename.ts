import { allDiffFiles, allTreeRows, type Suite } from '../harness.ts'

/** Renamed from `legacy.jsx` on the branch under review, and edited. */
const RENAMED = 'src/legacy.tsx'

export default {
  name: 'rename',
  async run({ page, load }, check) {
    await load()

    const rows = await allTreeRows(page)
    const row = rows.find((r) => r.path === RENAMED)
    check('a rename across languages is listed', Boolean(row), row?.path ?? 'missing')
    check('  and git calls it a rename', row?.status === 'renamed', row?.status ?? 'none')

    // The whole scroll: the pane virtualises, so a file missing at rest proves
    // nothing — and this file used to be missing everywhere.
    const files = await allDiffFiles(page)
    const rendered = files.find((f) => f.name.includes('legacy.tsx'))
    check(
      'and the diff pane renders it',
      Boolean(rendered),
      rendered?.name ?? `${files.length} files rendered, none of them legacy.tsx`,
    )
    // Rendered-but-empty is the shape the failure took: the file threw while
    // tokenising, so its box existed with nothing in it.
    check(
      '  with its contents highlighted',
      (rendered?.spans ?? 0) > 0,
      `${rendered?.spans ?? 0} coloured tokens`,
    )
  },
} satisfies Suite
