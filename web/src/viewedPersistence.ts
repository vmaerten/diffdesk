import { useMemo, useSyncExternalStore } from 'react'

import type { DiffPayload, ViewedMap } from '../../src/types.ts'

type ViewedReview = Pick<DiffPayload, 'range' | 'files' | 'viewed'>
type ViewedChange = { path: string; hash: string | null; viewed: boolean } | { clear: true }

interface ViewedTransport {
  write: (change: ViewedChange & { range: string }) => Promise<void>
}

interface Operation {
  change: ViewedChange
  completedAt: number | null
}

interface RangeState {
  served: ViewedMap
  operations: Operation[]
  tail: Promise<void>
}

/** Own optimistic Viewed, range-local write ordering and refresh reconciliation. */
export function createViewedPersistence(transport: ViewedTransport) {
  const ranges = new Map<string, RangeState>()
  const listeners = new Set<() => void>()
  let active: ViewedReview | null = null
  let snapshot: ViewedMap = {}
  let clock = 0
  let readVersion = 0

  const stateFor = (range: string) => {
    let state = ranges.get(range)
    if (!state) {
      state = { served: {}, operations: [], tail: Promise.resolve() }
      ranges.set(range, state)
    }
    return state
  }

  const publish = () => {
    const viewed: ViewedMap = {}
    if (active) {
      const state = stateFor(active.range)
      const current = { ...state.served }
      for (const { change } of state.operations) {
        if ('clear' in change) {
          for (const path of Object.keys(current)) delete current[path]
        } else if (change.viewed) current[change.path] = change.hash
        else delete current[change.path]
      }
      for (const file of active.files) {
        if (Object.hasOwn(current, file.path) && current[file.path] === file.hash)
          viewed[file.path] = file.hash
      }
    }
    snapshot = viewed
    for (const listener of listeners) listener()
  }

  const write = (change: ViewedChange) => {
    if (!active) return Promise.resolve()
    const range = active.range
    const state = stateFor(range)
    const operation: Operation = { change, completedAt: null }
    state.operations.push(operation)
    publish()
    // Reset and individual toggles share a queue; other ranges stay independent.
    const task = state.tail.then(async () => {
      try {
        await transport.write({ range, ...change })
        operation.completedAt = ++clock
      } catch (error) {
        state.operations = state.operations.filter((entry) => entry !== operation)
        throw error
      } finally {
        // Removing a failed operation retains all later optimistic gestures.
        if (active?.range === range) publish()
      }
    })
    state.tail = task.catch(() => {})
    return task
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: () => {
      const startedAt = clock
      const version = ++readVersion
      return (review: ViewedReview) => {
        if (version !== readVersion) return
        const state = stateFor(review.range)
        state.served = review.viewed
        // A read begun before a write settled cannot acknowledge that write.
        state.operations = state.operations.filter(
          (entry) => entry.completedAt === null || entry.completedAt > startedAt,
        )
        active = review
        publish()
      }
    },
    set: (path: string, viewed: boolean) => {
      const file = active?.files.find((entry) => entry.path === path)
      if (!file) return Promise.resolve()
      return write({ path, hash: file.hash, viewed })
    },
    reset: () => write({ clear: true }),
  }
}

export function useViewedPersistence(repoId: string | null) {
  const persistence = useMemo(
    () =>
      createViewedPersistence({
        write: async (change) => {
          const response = await fetch(`/r/${repoId}/api/viewed`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(change),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        },
      }),
    [repoId],
  )
  return [
    useSyncExternalStore(persistence.subscribe, persistence.getSnapshot),
    persistence,
  ] as const
}
