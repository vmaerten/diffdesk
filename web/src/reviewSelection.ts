import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useStableCallback } from '@pierre/diffs/react'

interface SelectionAdapter {
  replaceUrl: (url: URL) => void
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

let urlOwner = 0

/** Detaches existing selections from the URL; only selections created afterwards may write it. */
export function releaseUrl() {
  urlOwner++
}

/** URL transitions and request scope have one owner. */
export function createReviewSelection(initialUrl: URL, adapter: SelectionAdapter) {
  let url = new URL(initialUrl)
  let snapshot = describe(url)
  let active = true
  const owner = urlOwner
  const listeners = new Set<() => void>()
  const update = (change: (params: URLSearchParams) => void) => {
    if (!active || owner !== urlOwner) return
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
    setActive: (value: boolean) => {
      active = value
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pickTarget: (target: string | null) => {
      update((params) => {
        pick(params, 'target', target)
        params.delete('commit')
      })
    },
    pickCommit: (commit: string | null) => update((params) => pick(params, 'commit', commit)),
    toggleCommitted: () => toggle('committed'),
    toggleUntracked: () => toggle('untracked'),
    toggleWhitespace: () =>
      update((params) => pick(params, 'w', params.get('w') === '1' ? null : '1')),
    /**
     * The base for this review only, carried by the URL like `--base`. Null goes
     * back to the automatic base. Never written to the repository: a base picked
     * by mistake would otherwise empty the branch's reviews from then on.
     */
    pickBase: (base: string | null) => update((params) => pick(params, 'base', base)),
  }
}

export function useReviewSelection(onRouteChange?: (route: string) => void) {
  const routeChanged = useStableCallback((route: string) => onRouteChange?.(route))
  const selection = useMemo(
    () =>
      createReviewSelection(new URL(location.href), {
        replaceUrl: (url) => {
          history.replaceState(null, '', url)
          routeChanged(url.pathname + url.search)
        },
      }),
    [routeChanged],
  )
  useEffect(() => {
    selection.setActive(true)
    return () => selection.setActive(false)
  }, [selection])
  return [useSyncExternalStore(selection.subscribe, selection.getSnapshot), selection] as const
}
