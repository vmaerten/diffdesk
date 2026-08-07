import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { CodeView } from '@pierre/diffs/react'

import RefSelector from './RefSelector.jsx'
import FileTree from './FileTree.jsx'
import Resizer, { storedWidth } from './Resizer.jsx'

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

export default function App() {
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [diffStyle, setDiffStyle] = useState('unified')
  const [activeIndex, setActiveIndex] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  /** path -> hash of the diff section that was marked as read. */
  const [viewed, setViewedState] = useState({})
  const [showViewed, setShowViewed] = useState(false)
  const [picking, setPicking] = useState(null) // 'base' | 'target' | null
  /** Revision under review. null means the working tree of this checkout. */
  const [target, setTarget] = useState(() => new URLSearchParams(location.search).get('target'))
  const viewRef = useRef(null)
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef(null)
  const bodyRef = useRef(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)

  /**
   * The single refresh path.
   *
   * Everything that reloads the diff goes through here — the R key now, a
   * WebSocket later. Keeping it to one function is what makes the watcher a
   * ten-line change (discipline 4 in PLAN.md).
   */
  const refresh = useCallback(async () => {
    if (!repoId) return setError('no repository in the URL (expected /r/<repoId>)')
    setRefreshing(true)
    try {
      const query = target ? `?target=${encodeURIComponent(target)}` : ''
      const response = await fetch(`/r/${repoId}/api/diff${query}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setData(body)
      // The server already dropped ticks whose file changed since.
      setViewedState(body.viewed ?? {})
      setError(null)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setRefreshing(false)
    }
  }, [repoId, target])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** Review another revision. Kept in the URL so a reload stays on it. */
  const pickTarget = useCallback((ref) => {
    setPicking(null)
    setTarget(ref)
    const url = new URL(location.href)
    if (ref) url.searchParams.set('target', ref)
    else url.searchParams.delete('target')
    history.replaceState(null, '', url)
  }, [])

  /** Every file in the diff, in patch order. */
  const allItems = useMemo(() => {
    if (!data?.patch) return []
    return parsePatchFiles(data.patch, `${repoId}-${data.head.sha}`)
      .flatMap((patch) => patch.files ?? [])
      .map((fileDiff, index) => ({
        id: fileDiff.cacheKey ?? `file-${index}`,
        path: fileDiff.name,
        type: 'diff',
        fileDiff,
      }))
  }, [data, repoId])

  /**
   * What CodeView renders.
   *
   * A viewed file is REMOVED, never `collapsed: true`: collapsing shortens each
   * item, so more of them fit in the virtualisation window and the library
   * mounts more — measured at 4-5x the cost beyond ~87 files (decision 7).
   */
  const items = useMemo(
    () => (showViewed ? allItems : allItems.filter((item) => !(item.path in viewed))),
    [allItems, viewed, showViewed]
  )

  // Counts come from `git diff --numstat`, never from the parsed patch:
  // additionLines/deletionLines include context lines and overcount badly.
  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = Object.keys(viewed).length

  const untrackedSet = useMemo(() => new Set(data?.untracked ?? []), [data])

  /** Tree entries: every file, viewed or not, enriched with git's per-file counts. */
  const entries = useMemo(() => {
    const byPath = new Map((data?.files ?? []).map((f) => [f.path, f]))
    return allItems.map((item) => {
      const stat = byPath.get(item.path)
      return {
        id: item.id,
        path: item.path,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
        // Untracked files never reach `git diff`, so they carry no status of
        // their own — the untracked list is the only place that knows.
        status: untrackedSet.has(item.path) ? 'untracked' : (stat?.status ?? 'modified'),
        // Membership, not truthiness: the stored hash is null for files git
        // reports without one, and that must still count as viewed.
        viewed: item.path in viewed,
      }
    })
  }, [allItems, data, viewed, untrackedSet])

  const toggleViewed = useCallback(
    async (path, next) => {
      const hash = data?.files?.find((f) => f.path === path)?.hash ?? null
      // Optimistic: the diff pane reacts immediately, the write follows.
      setViewedState((current) => {
        const updated = { ...current }
        if (next) updated[path] = hash
        else delete updated[path]
        return updated
      })
      try {
        await fetch(`/r/${repoId}/api/viewed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ range: data.range, path, hash, viewed: next }),
        })
      } catch (cause) {
        setError(`could not save viewed state: ${cause.message}`)
      }
    },
    [data, repoId]
  )

  const resetViewed = useCallback(async () => {
    setViewedState({})
    await fetch(`/r/${repoId}/api/viewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: data.range, clear: true }),
    })
  }, [data, repoId])

  /** Remember the chosen base for this branch, then reload against it. */
  const pickBase = useCallback(
    async (base) => {
      setPicking(null)
      if (base === data?.base?.ref) return
      await fetch(`/r/${repoId}/api/base`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base, target }),
      })
      await refresh()
    },
    [data, repoId, refresh, target]
  )

  /** Navigation walks the rendered items — what is left to read. */
  const goTo = useCallback(
    (index) => {
      const bounded = Math.max(0, Math.min(index, items.length - 1))
      // Not `target`: that name already means the revision under review.
      const item = items[bounded]
      if (!item) return
      setActiveIndex(bounded)

      // The tree folds directories, so ask it to bring the file back into view
      // rather than moving the selection somewhere invisible.
      treeRef.current?.reveal(item.path)
      viewRef.current?.scrollTo({ type: 'item', id: item.id, align: 'start' })
    },
    [items]
  )

  /** Clicking a viewed file brings it back rather than jumping to nothing. */
  const selectByPath = useCallback(
    (path) => {
      const entry = entries.find((e) => e.path === path)
      if (entry?.viewed && !showViewed) return toggleViewed(path, false)
      goTo(items.findIndex((item) => item.path === path))
    },
    [entries, items, goTo, toggleViewed, showViewed]
  )

  useEffect(() => {
    const onKeyDown = (event) => {
      // Never steal keys from an input or from a browser shortcut.
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (picking) return // the picker owns the keyboard while open

      if (event.key === 'b') setPicking('base')
      else if (event.key === 't') setPicking('target')
      else if (event.key === 'j') goTo(activeIndex + 1)
      else if (event.key === 'k') goTo(activeIndex - 1)
      else if (event.key === 'r' || event.key === 'R') refresh()
      else if (event.key === 'v') {
        const current = items[activeIndex]
        if (current) toggleViewed(current.path, !(current.path in viewed))
      } else return

      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, goTo, refresh, items, viewed, toggleViewed, picking])

  const resizeSidebar = useCallback((width) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  const options = useMemo(
    () => ({ diffStyle, theme: 'github-dark', stickyHeaders: true }),
    [diffStyle]
  )

  /** The Viewed control lives in the library's own file header. */
  const renderHeaderMetadata = useCallback(
    (item) => {
      const path = item.fileDiff?.name
      if (!path) return null
      const isViewed = path in viewed
      return (
        <label className="viewed-toggle" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={isViewed}
            onChange={() => toggleViewed(path, !isViewed)}
          />
          Viewed
        </label>
      )
    },
    [viewed, toggleViewed]
  )

  const baseSource = {
    override: 'given on the command line',
    remembered: 'remembered',
    guessed: 'guessed',
    trunk: 'trunk',
  }[data?.base?.source]

  const activePath = items[activeIndex]?.path
  const allRead = data && allItems.length > 0 && items.length === 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="revision">
          <span className="base-anchor">
            <button
              type="button"
              className="ref base"
              onClick={() => setPicking((p) => (p === 'base' ? null : 'base'))}
              title="Change the base (b)"
              aria-expanded={picking === 'base'}
              disabled={!data}
            >
              {data?.base?.ref ?? '…'} <span className="caret">▾</span>
            </button>

            {picking === 'base' && data && (
              <RefSelector
                repoId={repoId}
                current={data.base.ref}
                source={data.base.source}
                onPick={pickBase}
                onClose={() => setPicking(null)}
              />
            )}
          </span>

          <span className="arrow">→</span>

          <span className="base-anchor">
            <button
              type="button"
              className="ref target"
              onClick={() => setPicking((p) => (p === 'target' ? null : 'target'))}
              title="Review another revision (t)"
              aria-expanded={picking === 'target'}
              disabled={!data}
            >
              {data?.target?.ref ?? 'HEAD'} <span className="caret">▾</span>
            </button>

            {picking === 'target' && data && (
              <RefSelector
                repoId={repoId}
                current={data.target.ref}
                source={data.target.workingTree ? 'working tree' : 'ref'}
                extra={{
                  value: '__working_tree__ this checkout working tree',
                  label: 'This checkout (working tree)',
                  hint: 'uncommitted work included',
                  pick: null,
                }}
                onPick={pickTarget}
                onClose={() => setPicking(null)}
              />
            )}
          </span>

          {baseSource && <span className="source">base {baseSource}</span>}
          {data && !data.target.workingTree && (
            <span className="source">reviewing a ref, working tree excluded</span>
          )}
        </div>

        {data && (
          <span className="stats">
            {stats.files} files <span className="add">+{stats.additions}</span>{' '}
            <span className="del">−{stats.deletions}</span>
          </span>
        )}

        <span className="spacer" />

        <span className="hint">
          <kbd>b</kbd> base · <kbd>j</kbd>
          <kbd>k</kbd> files · <kbd>v</kbd> viewed · <kbd>r</kbd> refresh
        </span>

        <button type="button" className="refresh" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>

        <div className="toggle">
          <button
            type="button"
            aria-pressed={diffStyle === 'unified'}
            onClick={() => setDiffStyle('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            aria-pressed={diffStyle === 'split'}
            onClick={() => setDiffStyle('split')}
          >
            Split
          </button>
        </div>
      </header>

      {data?.state?.operation && (
        <div className="warning">
          {data.state.operation} in progress — {data.state.conflicted.length} conflicted file(s).
          This diff may not mean what you expect.
        </div>
      )}

      {data?.untracked?.length > 0 && !data.untrackedIncluded && (
        <div className="warning">
          {data.untracked.length} untracked file(s) hidden. Run with <code>--untracked</code> to
          include them.
        </div>
      )}

      {error && <p className="message">{error}</p>}

      {!error && data && allItems.length === 0 && (
        <p className="message">
          Nothing to show — <code>{data.head.branch}</code> matches <code>{data.base.ref}</code>.
        </p>
      )}

      {allItems.length > 0 && (
        <div className="body" ref={bodyRef} style={{ '--sidebar-width': `${sidebarWidth}px` }}>
          <aside className="sidebar">
            <div className="sidebar-head">
              <span>
                {viewedCount > 0 ? `${viewedCount}/${entries.length} viewed` : `${entries.length} files`}
              </span>
              <span className="spacer" />
              {viewedCount > 0 && (
                <button type="button" onClick={resetViewed} title="Unmark every file">
                  Reset
                </button>
              )}
              <button type="button" onClick={() => treeRef.current?.collapseAll()}>
                Collapse all
              </button>
              <button type="button" onClick={() => treeRef.current?.expandAll()}>
                Expand all
              </button>
            </div>
            <FileTree
              ref={treeRef}
              entries={entries}
              activePath={activePath}
              onSelect={selectByPath}
            />
          </aside>

          <Resizer containerRef={bodyRef} onCommit={resizeSidebar} />

          {allRead ? (
            <p className="message">
              All {entries.length} files reviewed.{' '}
              <button type="button" className="link" onClick={() => setShowViewed(true)}>
                Show them again
              </button>
            </p>
          ) : (
            /* CodeView owns its scrolling. The style lands on its own scroller, so it
               needs both a real height (or it measures 0 and mounts nothing) and
               `overflowY: auto` — it only recomputes the virtual window from the
               element it scrolls itself, never from an ancestor. */
            <div className="diff">
              {viewedCount > 0 && (
                <div className="viewed-bar">
                  {viewedCount} viewed file(s) hidden
                  <button type="button" className="link" onClick={() => setShowViewed((v) => !v)}>
                    {showViewed ? 'Hide them' : 'Show them'}
                  </button>
                </div>
              )}
              <CodeView
                ref={viewRef}
                items={items}
                options={options}
                renderHeaderMetadata={renderHeaderMetadata}
                style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
