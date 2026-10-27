import { createDebugLog } from '../web/src/debugLog.ts'
import type { Check } from './harness.ts'

export async function runDebugLog(check: Check): Promise<void> {
  let disk = ''
  const transport = {
    append: async (raw: string) => {
      disk += raw + '\n'
    },
    read: async () => disk,
    clear: async () => {
      disk = ''
    },
  }
  const log = createDebugLog(transport)
  log.record('comment.open', { path: 'file.ts', line: 10 })
  await log.flush()
  check('debug logging is off by default and writes nothing', disk === '')
  log.configure(true)
  for (let i = 0; i < 500; i++) log.record('scroll.jump', { from: i, to: i + 1000 })
  await log.flush()
  const reopened = createDebugLog(transport)
  const events = JSON.parse(await reopened.text()).events
  check(
    'all events survive a new page, without pruning older events',
    events.length === 501 && events[1].details.from === 0 && events.at(-1).details.from === 499,
  )
  log.configure(false)
  await log.flush()
  const disabled = disk
  log.record('comment.submit', { path: 'file.ts' })
  await log.flush()
  check(
    'disabling logging stops new events and preserves the history',
    disk === disabled && JSON.parse(await log.text()).events.length === 502,
  )
  await log.clear()
  check(
    'clearing removes the history across page reloads',
    JSON.parse(await reopened.text()).events.length === 0,
  )
  const failing = createDebugLog({
    ...transport,
    append: async () => {
      throw new Error('disk unavailable')
    },
  })
  failing.configure(true)
  failing.record('comment.open')
  check(
    'failed writes remain available in the export',
    JSON.parse(await failing.text()).unsavedEvents.length === 2,
  )
  await failing.clear()
  check(
    'clearing also releases unsaved events',
    JSON.parse(await failing.text()).unsavedEvents === undefined,
  )
  const unreadable = createDebugLog({
    ...transport,
    read: async () => {
      throw new Error('read failed')
    },
  })
  check(
    'a failed file read is explicit in the export',
    JSON.parse(await unreadable.text()).readFailed === true,
  )
}
