import { createFixture } from './fixture.ts'
import { withHarness, type Check, type Suite } from './harness.ts'
import { runLifecycle } from './lifecycle.ts'

import tree from './suites/tree.ts'
import resize from './suites/resize.ts'
import viewed from './suites/viewed.ts'
import pickers from './suites/pickers.ts'
import scroll from './suites/scroll.ts'
import rename from './suites/rename.ts'
import order from './suites/order.ts'
import stack from './suites/stack.ts'

const SUITES: Suite[] = [tree, resize, viewed, pickers, scroll, rename, order, stack]

/** Not a browser suite: it drives real CLI processes, so it runs on its own. */
const LIFECYCLE = 'lifecycle'

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const selected = only.length > 0 ? SUITES.filter((s) => only.includes(s.name)) : SUITES
const lifecycle = only.length === 0 || only.includes(LIFECYCLE)

if (selected.length === 0 && !lifecycle) {
  const names = [LIFECYCLE, ...SUITES.map((s) => s.name)].join(', ')
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

if (lifecycle) {
  process.stdout.write(`\n${LIFECYCLE}\n`)
  try {
    await runLifecycle(check)
  } catch (error) {
    failures += 1
    total += 1
    const detail = error instanceof Error ? error.message : String(error)
    process.stdout.write(`  FAIL ${LIFECYCLE} threw  — ${detail}\n`)
  }
}

// Skipped entirely when only the lifecycle suite was asked for: no fixture to
// build, and no browser to start.
if (selected.length > 0) {
  const fixture = createFixture()

  try {
    await withHarness(fixture.path, async (make) => {
      for (const suite of selected) {
        process.stdout.write(`\n${suite.name}\n`)
        const harness = await make('feature')

        try {
          await suite.run(harness, check)
          check(
            'no page errors',
            harness.errors.length === 0,
            harness.errors.slice(0, 2).join(' | '),
          )
        } catch (error) {
          failures += 1
          total += 1
          const detail = error instanceof Error ? error.message : String(error)
          process.stdout.write(`  FAIL ${suite.name} threw  — ${detail}\n`)
        } finally {
          await harness.page.close()
        }
      }
    })
  } finally {
    fixture.cleanup()
  }
}

process.stdout.write(
  failures === 0 ? `\n${total} checks passed\n` : `\n${failures} of ${total} checks FAILED\n`,
)
process.exit(failures === 0 ? 0 : 1)
