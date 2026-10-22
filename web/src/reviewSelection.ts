import { useEffect, useMemo, useSyncExternalStore } from 'react'

interface SelectionAdapter {
  replaceUrl: (url: URL) => void
  rememberBase: (base: string, target: string | null) => Promise<void>
  worktreeForTarget: (target: string) => Promise<string | null>
  navigate: (url: URL) => void
}

function describe(url: URL) {
  const params = url.searchParams
  const query = new URLSearchParams()
  for (const key of ['base', 'target', 'commit']) {
    const value = params.get(key)
    if (value) query.set(key, value)
  }
  for (const key of ['committed', 'untracked']) {
    if (params.has(key)) query.set(key, '1')
  }
  const ignoreWhitespace = params.get('w') === '1'
  if (ignoreWhitespace) query.set('w', '1')
  return {
    target: params.get('target'),
    commit: params.get('commit'),
    committed: params.has('committed'),
    withUntracked: params.has('untracked'),
    ignoreWhitespace,
    query: query.size ? `?${query}` : '',
  }
}

function pick(params: URLSearchParams, key: string, value: string | null) {
  if (value) params.set(key, value)
  else params.delete(key)
}

/** URL transitions and request scope have one owner, including remembered bases. */
export function createReviewSelection(initialUrl: URL, adapter: SelectionAdapter) {
  let url = new URL(initialUrl)
  let snapshot = describe(url)
  let baseRequest = 0
  let targetRequest = 0
  let baseWrite = Promise.resolve()
  const listeners = new Set<() => void>()
  const update = (change: (params: URLSearchParams) => void) => {
    const next = new URL(url)
    change(next.searchParams)
    adapter.replaceUrl(next)
    url = next
    snapshot = describe(url)
    for (const listener of listeners) listener()
  }
  const toggle = (key: string) =>
    update((params) => {
      if (params.has(key)) params.delete(key)
      else params.set(key, '1')
    })

  return {
    cancelPending: () => {
      baseRequest++
      targetRequest++
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pickTarget: async (target: string | null) => {
      baseRequest++
      const request = ++targetRequest
      let worktreeId: string | null = null
      if (target) {
        try {
          worktreeId = await adapter.worktreeForTarget(target)
        } catch (error) {
          if (request !== targetRequest) return
          throw error
        }
        if (request !== targetRequest) return
      }
      if (worktreeId) {
        const next = new URL(url)
        const path = `/r/${encodeURIComponent(worktreeId)}`
        for (const key of ['target', 'commit', 'committed']) next.searchParams.delete(key)
        if (next.pathname.replace(/\/$/, '') !== path) {
          next.pathname = path
          next.searchParams.delete('base')
          next.hash = ''
          adapter.navigate(next)
          return
        }
        // Picking the checked-out branch also includes its local changes.
        target = null
      }
      update((params) => {
        pick(params, 'target', target)
        params.delete('commit')
        if (worktreeId) params.delete('committed')
      })
    },
    pickCommit: (commit: string | null) => {
      targetRequest++
      update((params) => pick(params, 'commit', commit))
    },
    toggleCommitted: () => toggle('committed'),
    toggleUntracked: () => toggle('untracked'),
    toggleWhitespace: () =>
      update((params) => pick(params, 'w', params.get('w') === '1' ? null : '1')),
    pickBase: async (base: string | null, currentBase: string | undefined) => {
      if (!base || base === currentBase) return
      targetRequest++
      const request = ++baseRequest
      const target = snapshot.target
      const write = baseWrite.then(() => adapter.rememberBase(base, target))
      baseWrite = write.catch(() => {})
      await write
      if (request !== baseRequest) return
      // Publish even without an override: the remembered base changes the request's meaning.
      update((params) => params.delete('base'))
    },
  }
}

export function useReviewSelection(repoId: string | null, navigate: (url: URL) => void) {
  const selection = useMemo(
    () =>
      createReviewSelection(new URL(location.href), {
        replaceUrl: (url) => history.replaceState(null, '', url),
        navigate,
        worktreeForTarget: async (target) => {
          const response = await fetch(`/r/${repoId}/api/worktree`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ branch: target }),
          })
          const body: { repo?: { id: string } | null; error?: string } = await response.json()
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
          return body.repo?.id ?? null
        },
        rememberBase: async (base, target) => {
          const response = await fetch(`/r/${repoId}/api/base`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base, target }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
        },
      }),
    [repoId, navigate],
  )
  useEffect(() => () => selection.cancelPending(), [selection])
  return [useSyncExternalStore(selection.subscribe, selection.getSnapshot), selection] as const
}
