import { availableParallelism } from 'node:os'

import { createFixture } from './fixture.ts'
import { withHarness, type Check, type Suite } from './harness.ts'
import { runExport } from './export.ts'
import { runReviewSelection } from './reviewSelection.ts'
import { runCommentPersistence } from './commentPersistence.ts'
import { runViewedPersistence } from './viewedPersistence.ts'
import { runDesktopSettings } from './desktopSettings.ts'
import { runTabOverflow } from './tabOverflow.ts'
import { runCommentRange } from './commentRange.ts'
import { runPaletteMatch } from './paletteMatch.ts'
import { runDebugLog } from './debugLog.ts'

import reviewPanel from './suites/reviewPanel.ts'
import themes from './suites/themes.ts'
import tree from './suites/tree.ts'
import resize from './suites/resize.ts'
import viewed from './suites/viewed.ts'
import comments from './suites/comments.ts'
import scopedComments from './suites/scopedComments.ts'
import pickers from './suites/pickers.ts'
import scroll from './suites/scroll.ts'
import rename from './suites/rename.ts'
import order from './suites/order.ts'
import stack from './suites/stack.ts'
import commits from './suites/commits.ts'
import worktree from './suites/worktree.ts'
import untracked from './suites/untracked.ts'
import search from './suites/search.ts'
import whitespace from './suites/whitespace.ts'
import wrap from './suites/wrap.ts'
import markdown from './suites/markdown.ts'
import fileMenu from './suites/fileMenu.ts'
import codeIntelligence from './suites/codeIntelligence.ts'
import resolve from './suites/resolve.ts'
import github from './suites/github.ts'
import palette from './suites/palette.ts'
import debugLogging from './suites/debugLogging.ts'
import updates from './suites/updates.ts'

const SUITES: Suite[] = [
  themes,
  reviewPanel,
  tree,
  resize,
  viewed,
  comments,
  scopedComments,
  pickers,
  scroll,
  rename,
  order,
  stack,
  commits,
  worktree,
  untracked,
  search,
  whitespace,
  wrap,
  markdown,
  fileMenu,
  codeIntelligence,
  resolve,
  github,
  palette,
  debugLogging,
  updates,
]

/**
 * Pure frontend helpers, checked without starting a server or browser.
 */
const PLAIN: { name: string; run: (check: Check) => Promise<void> }[] = [
  { name: 'review-selection', run: runReviewSelection },
  { name: 'comment-persistence', run: runCommentPersistence },
  { name: 'viewed-persistence', run: runViewedPersistence },
  { name: 'desktop-settings', run: runDesktopSettings },
  { name: 'tab-overflow', run: runTabOverflow },
  { name: 'export', run: runExport },
  { name: 'comment-range', run: runCommentRange },
  { name: 'palette-match', run: runPaletteMatch },
  { name: 'debug-log', run: runDebugLog },
]

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const selected = only.length > 0 ? SUITES.filter((s) => only.includes(s.name)) : SUITES
const plain = only.length > 0 ? PLAIN.filter((s) => only.includes(s.name)) : PLAIN

if (selected.length === 0 && plain.length === 0) {
  const names = [...PLAIN.map((s) => s.name), ...SUITES.map((s) => s.name)].join(', ')
  process.stderr.write(`no such suite. available: ${names}\n`)
  process.exit(1)
}

let failures = 0
let total = 0

const check: Check = (name, ok, detail) => {
  total += 1
  if (!ok) failures += 1
  const mark = ok ? '  ok  ' : '  FAIL'
  process.stdout.write(`${mark} ${name}${detail ? `  — ${detail}` : ''}\n`)
}

for (const suite of plain) {
  process.stdout.write(`\n${suite.name}\n`)
  try {
    await suite.run(check)
  } catch (error) {
    failures += 1
    total += 1
    const detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  FAIL ${suite.name} threw  — ${detail}\n`)
  }
}

// Skipped entirely when only a browser-free suite was asked for: no fixture to
// build, and no browser to start.
if (selected.length > 0) {
  // One fixture per suite, so suites cannot leak state into each other and can
  // run side by side. Built up front: Git runs synchronously and would stall the
  // suites already driving a page.
  const fixtures = selected.map(() => createFixture())
  // Each suite drives its own renderer: half the cores keeps them from starving each other.
  const jobs = Math.max(
    1,
    Number(process.env.DIFFDESK_TEST_JOBS ?? Math.min(8, Math.floor(availableParallelism() / 2))),
  )

  try {
    await withHarness(fixtures[0]!.path, async (make) => {
      const run = async (suite: Suite, fixture: (typeof fixtures)[number]) => {
        // Buffered, so parallel suites print in one piece each.
        const started = performance.now()
        let output = ''
        const record: Check = (name, ok, detail) => {
          total += 1
          if (!ok) failures += 1
          output += `${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}\n`
        }
        const harness = await make('feature', fixture.path)
        try {
          await suite.run(harness, record)
          record(
            'no page errors',
            harness.errors.length === 0,
            harness.errors.slice(0, 2).join(' | '),
          )
        } catch (error) {
          record(
            `${suite.name} threw`,
            false,
            error instanceof Error ? error.message : String(error),
          )
        } finally {
          await harness.page.close()
          const seconds = ((performance.now() - started) / 1000).toFixed(1)
          process.stdout.write(`\n${suite.name} (${seconds}s)\n${output}`)
        }
      }
      const queue = selected.map((suite, index) => () => run(suite, fixtures[index]!))
      await Promise.all(
        Array.from({ length: Math.min(jobs, queue.length) }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) await next()
        }),
      )
    })
  } finally {
    for (const fixture of fixtures) fixture.cleanup()
  }
}

process.stdout.write(
  failures === 0 ? `\n${total} checks passed\n` : `\n${failures} of ${total} checks FAILED\n`,
)
process.exit(failures === 0 ? 0 : 1)
