import { useMemo, useSyncExternalStore } from 'react'

import type { DiffPayload, ViewedMap } from '../../src/types.ts'

type ViewedReview = Pick<DiffPayload, 'range' | 'files' | 'viewed'> & { query: string }
type ViewedChange = { path: string; hash: string | null; viewed: boolean } | { clear: true }

interface ViewedTransport {
  write: (change: ViewedChange & { range: string; query: string }) => Promise<void>
}

interface Operation {
  change: ViewedChange
  completedAt: number | null
}

interface ScopeState {
  served: ViewedMap
  operations: Operation[]
  tail: Promise<void>
}

// Full and whitespace-filtered reviews have independent persisted Viewed maps.
const scopeKey = (review: ViewedReview) =>
  JSON.stringify([review.range, new URLSearchParams(review.query).get('w') === '1'])

/** Own optimistic Viewed, scope-local write ordering and refresh reconciliation. */
export function createViewedPersistence(transport: ViewedTransport) {
  const scopes = new Map<string, ScopeState>()
  const listeners = new Set<() => void>()
  let active: ViewedReview | null = null
  let snapshot: ViewedMap = {}
  let clock = 0
  let readVersion = 0

  const stateFor = (key: string) => {
    let state = scopes.get(key)
    if (!state) {
      state = { served: {}, operations: [], tail: Promise.resolve() }
      scopes.set(key, state)
    }
    return state
  }

  const publish = () => {
    const viewed: ViewedMap = {}
    if (active) {
      const state = stateFor(scopeKey(active))
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
    const { range, query } = active
    const key = scopeKey(active)
    const state = stateFor(key)
    const operation: Operation = { change, completedAt: null }
    state.operations.push(operation)
    publish()
    // Reset and individual toggles share a queue; other scopes stay independent.
    const task = state.tail.then(async () => {
      try {
        await transport.write({ range, query, ...change })
        operation.completedAt = ++clock
      } catch (error) {
        state.operations = state.operations.filter((entry) => entry !== operation)
        throw error
      } finally {
        // Removing a failed operation retains all later optimistic gestures.
        if (active && scopeKey(active) === key) publish()
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
        const state = stateFor(scopeKey(review))
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

export type ViewedPersistence = ReturnType<typeof createViewedPersistence>

export function createRepositoryViewedPersistence(repoId: string | null): ViewedPersistence {
  return createViewedPersistence({
    write: async ({ query, ...change }) => {
      const response = await fetch(`/r/${repoId}/api/viewed${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    },
  })
}

export function useViewedPersistence(repoId: string | null, retained?: ViewedPersistence) {
  const persistence = useMemo(
    () => retained ?? createRepositoryViewedPersistence(repoId),
    [repoId, retained],
  )
  return [
    useSyncExternalStore(persistence.subscribe, persistence.getSnapshot),
    persistence,
  ] as const
}
