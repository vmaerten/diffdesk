import { createViewedPersistence } from '../web/src/viewedPersistence.ts'
import type { DiffPayload, ViewedMap } from '../src/types.ts'
import type { Check } from './harness.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function review(
  viewed: ViewedMap = {},
  range = 'main..feature',
): Pick<DiffPayload, 'range' | 'files' | 'viewed'> {
  return {
    range,
    viewed,
    files: ['a.ts', 'b.ts'].map((path) => ({
      path,
      hash: path,
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
    })),
  }
}

function setup(viewed: ViewedMap = {}) {
  type Change = Parameters<Parameters<typeof createViewedPersistence>[0]['write']>[0]
  const requests: ({ change: Change } & ReturnType<typeof deferred>)[] = []
  const store = createViewedPersistence({
    write: (change) => {
      const request = { change, ...deferred() }
      requests.push(request)
      return request.promise
    },
  })
  store.refresh()(review(viewed))
  return { store, requests }
}

export async function runViewedPersistence(check: Check): Promise<void> {
  {
    const { store, requests } = setup()
    let publications = 0
    const unsubscribe = store.subscribe(() => publications++)
    const mark = store.set('a.ts', true)
    check('Viewed updates optimistically', store.getSnapshot()['a.ts'] === 'a.ts')
    const staleRead = store.refresh()
    await Promise.resolve()
    requests[0]!.resolve()
    await mark
    staleRead(review())
    check('a stale refresh cannot undo a confirmed tick', store.getSnapshot()['a.ts'] === 'a.ts')
    store.refresh()(review({ 'a.ts': 'a.ts' }))
    check('a fresh refresh acknowledges the saved tick', store.getSnapshot()['a.ts'] === 'a.ts')
    unsubscribe()
    const before = publications
    store.refresh()(review())
    check('fresh server changes replace confirmed state', !('a.ts' in store.getSnapshot()))
    check('unsubscribed Viewed readers stop receiving updates', publications === before)
  }
  {
    const { store, requests } = setup({ 'b.ts': 'b.ts' })
    const mark = store.set('a.ts', true).catch((error: unknown) => error)
    const receive = store.refresh()
    receive(review({ 'b.ts': 'b.ts' }))
    check('refresh retains pending Viewed gestures', store.getSnapshot()['a.ts'] === 'a.ts')
    await Promise.resolve()
    requests[0]!.reject(new Error('offline'))
    check('Viewed failures reach the caller', (await mark) instanceof Error)
    check(
      'failed ticks restore the confirmed map',
      !('a.ts' in store.getSnapshot()) && store.getSnapshot()['b.ts'] === 'b.ts',
    )
  }
  {
    const { store, requests } = setup()
    const first = store.set('a.ts', true).catch((error: unknown) => error)
    const second = store.set('a.ts', false)
    await Promise.resolve()
    check('rapid toggles serialize their writes', requests.length === 1)
    requests[0]!.reject(new Error('first write failed'))
    await first
    await Promise.resolve()
    check('rollback preserves a newer gesture', !('a.ts' in store.getSnapshot()))
    check(
      'failure does not block the next write',
      requests.length === 2 && 'viewed' in requests[1]!.change && !requests[1]!.change.viewed,
    )
    requests[1]!.resolve()
    await second
  }
  {
    const { store, requests } = setup()
    const mark = store.set('a.ts', true)
    await Promise.resolve()
    requests[0]!.resolve()
    await mark
    const unmark = store.set('a.ts', false).catch((error: unknown) => error)
    await Promise.resolve()
    check('unmarking is optimistic', !('a.ts' in store.getSnapshot()))
    requests[1]!.reject(new Error('unmark failed'))
    await unmark
    check(
      'rollback restores the last confirmed write without requiring refresh',
      store.getSnapshot()['a.ts'] === 'a.ts',
    )
  }
  {
    const { store, requests } = setup({ 'a.ts': 'a.ts' })
    const reset = store.reset().catch((error: unknown) => error)
    const mark = store.set('b.ts', true)
    check('reset clears optimistically', !('a.ts' in store.getSnapshot()))
    await Promise.resolve()
    check('a tick waits behind reset', requests.length === 1 && 'clear' in requests[0]!.change)
    requests[0]!.reject(new Error('reset failed'))
    await reset
    await Promise.resolve()
    check(
      'failed reset restores confirmed ticks and preserves newer gestures',
      store.getSnapshot()['a.ts'] === 'a.ts' && store.getSnapshot()['b.ts'] === 'b.ts',
    )
    requests[1]!.resolve()
    await mark
  }
  {
    const { store, requests } = setup({ 'a.ts': 'a.ts' })
    const mark = store.set('b.ts', true)
    const reset = store.reset()
    const stale = store.refresh()
    await Promise.resolve()
    requests[0]!.resolve()
    await mark
    await Promise.resolve()
    requests[1]!.resolve()
    await reset
    stale(review({ 'a.ts': 'a.ts', 'b.ts': 'b.ts' }))
    check(
      'a stale refresh cannot resurrect ticks after reset',
      Object.keys(store.getSnapshot()).length === 0,
    )
  }
  {
    const { store, requests } = setup()
    const oldMark = store.set('a.ts', true)
    await Promise.resolve()
    store.refresh()(review({}, 'main..other'))
    const otherMark = store.set('b.ts', true)
    await Promise.resolve()
    check('other comparisons save independently', requests.length === 2)
    requests[0]!.resolve()
    await oldMark
    check(
      'old write completion cannot tick the new comparison',
      !('a.ts' in store.getSnapshot()) && store.getSnapshot()['b.ts'] === 'b.ts',
    )
    check(
      'each write keeps its original range',
      requests[0]!.change.range === 'main..feature' && requests[1]!.change.range === 'main..other',
    )
    requests[1]!.resolve()
    await otherMark
    store.refresh()(review({ 'a.ts': 'a.ts' }))
    check(
      'returning to a comparison restores its saved ticks',
      store.getSnapshot()['a.ts'] === 'a.ts' && !('b.ts' in store.getSnapshot()),
    )
  }
  {
    const { store, requests } = setup()
    const mark = store.set('a.ts', true).catch((error: unknown) => error)
    await Promise.resolve()
    const changed = review()
    changed.files[0]!.hash = 'new content'
    store.refresh()(changed)
    check('a pending tick does not apply to changed contents', !('a.ts' in store.getSnapshot()))
    requests[0]!.reject(new Error('old write failed'))
    await mark
    check('rollback cannot restore a tick on changed contents', !('a.ts' in store.getSnapshot()))
    const oldRead = store.refresh()
    store.refresh()(review({}, 'main..other'))
    oldRead(review({ 'a.ts': 'a.ts' }))
    check(
      'late reads cannot restore a previous comparison',
      Object.keys(store.getSnapshot()).length === 0,
    )
    await store.set('missing.ts', true)
    check('unavailable files do not send writes', requests.length === 1)
  }
}
