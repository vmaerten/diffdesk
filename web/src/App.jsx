import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { CodeView } from '@pierre/diffs/react'

import FileTree, { allDirPaths, buildTree } from './FileTree.jsx'

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
  /** Folded directory paths. Survives a refresh, since it does not derive from data. */
  const [collapsed, setCollapsed] = useState(() => new Set())
  /** path -> hash of the diff section that was marked as read. */
  const [viewed, setViewedState] = useState({})
  const [showViewed, setShowViewed] = useState(false)
  const viewRef = useRef(null)

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
      const response = await fetch(`/r/${repoId}/api/diff`)
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
  }, [repoId])

  useEffect(() => {
    refresh()
  }, [refresh])

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
        // Membership, not truthiness: the stored hash is null for files git
        // reports without one, and that must still count as viewed.
        viewed: item.path in viewed,
      }
    })
  }, [allItems, data, viewed])

  const tree = useMemo(() => buildTree(entries), [entries])

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

  /** Navigation walks the rendered items — what is left to read. */
  const goTo = useCallback(
    (index) => {
      const bounded = Math.max(0, Math.min(index, items.length - 1))
      const target = items[bounded]
      if (!target) return
      setActiveIndex(bounded)

      // Reveal the file if it sits inside folded directories, rather than
      // moving the selection somewhere invisible.
      const ancestors = target.path.split('/').slice(0, -1)
      const prefixes = ancestors.map((_, i) => ancestors.slice(0, i + 1).join('/'))
      setCollapsed((current) => {
        if (!prefixes.some((p) => current.has(p))) return current
        const next = new Set(current)
        for (const prefix of prefixes) next.delete(prefix)
        return next
      })

      viewRef.current?.scrollTo({ type: 'item', id: target.id, align: 'start' })
    },
    [items]
  )

  /** Clicking a viewed file brings it back rather than jumping to nothing. */
  const selectById = useCallback(
    (id) => {
      const entry = entries.find((e) => e.id === id)
      if (entry?.viewed && !showViewed) return toggleViewed(entry.path, false)
      goTo(items.findIndex((item) => item.id === id))
    },
    [entries, items, goTo, toggleViewed, showViewed]
  )

  const toggleDir = useCallback((path) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => setCollapsed(new Set(allDirPaths(tree))), [tree])
  const expandAll = useCallback(() => setCollapsed(new Set()), [])

  useEffect(() => {
    const onKeyDown = (event) => {
      // Never steal keys from an input or from a browser shortcut.
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'j') goTo(activeIndex + 1)
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
  }, [activeIndex, goTo, refresh, items, viewed, toggleViewed])

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

  const activeId = items[activeIndex]?.id
  const allRead = data && allItems.length > 0 && items.length === 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="revision">
          <span className="ref">{data?.base?.ref ?? '…'}</span>
          <span className="arrow">→</span>
          <span className="ref target">{data?.head?.branch ?? 'HEAD'}</span>
          {baseSource && <span className="source">base {baseSource}</span>}
        </div>

        {data && (
          <span className="stats">
            {stats.files} files <span className="add">+{stats.additions}</span>{' '}
            <span className="del">−{stats.deletions}</span>
          </span>
        )}

        <span className="spacer" />

        <span className="hint">
          <kbd>j</kbd>
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
        <div className="body">
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
              <button type="button" onClick={collapseAll}>
                Collapse all
              </button>
              <button type="button" onClick={expandAll}>
                Expand all
              </button>
            </div>
            <FileTree
              tree={tree}
              activeId={activeId}
              collapsed={collapsed}
              onSelect={selectById}
              onToggle={toggleDir}
            />
          </aside>

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
