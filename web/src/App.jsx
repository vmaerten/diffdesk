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

  const items = useMemo(() => {
    if (!data?.patch) return []

    const files = parsePatchFiles(data.patch, `${repoId}-${data.head.sha}`).flatMap(
      (patch) => patch.files ?? []
    )

    // No `collapsed` anywhere: collapsing saturates the virtualisation window
    // and costs 4-5x beyond ~87 files (decision 7 in PLAN.md).
    return files.map((fileDiff, index) => ({
      id: fileDiff.cacheKey ?? `file-${index}`,
      type: 'diff',
      fileDiff,
    }))
  }, [data, repoId])

  // Counts come from `git diff --numstat`, never from the parsed patch:
  // additionLines/deletionLines include context lines and overcount badly.
  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }

  /** Tree entries: patch order, enriched with git's per-file counts. */
  const entries = useMemo(() => {
    const byPath = new Map((data?.files ?? []).map((f) => [f.path, f]))
    return items.map((item) => {
      const path = item.fileDiff.name
      const stat = byPath.get(path)
      return {
        id: item.id,
        path,
        additions: stat?.additions ?? 0,
        deletions: stat?.deletions ?? 0,
        binary: stat?.binary ?? false,
      }
    })
  }, [items, data])

  const tree = useMemo(() => buildTree(entries), [entries])

  const goTo = useCallback(
    (index) => {
      const bounded = Math.max(0, Math.min(index, items.length - 1))
      const target = items[bounded]
      if (!target) return
      setActiveIndex(bounded)

      // Reveal the file if it sits inside folded directories, rather than
      // moving the selection somewhere invisible.
      const path = entries[bounded]?.path
      if (path) {
        const ancestors = path.split('/').slice(0, -1)
        const prefixes = ancestors.map((_, i) => ancestors.slice(0, i + 1).join('/'))
        setCollapsed((current) => {
          if (!prefixes.some((p) => current.has(p))) return current
          const next = new Set(current)
          for (const prefix of prefixes) next.delete(prefix)
          return next
        })
      }

      viewRef.current?.scrollTo({ type: 'item', id: target.id, align: 'start' })
    },
    [items, entries]
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

  const selectById = useCallback(
    (id) => goTo(items.findIndex((item) => item.id === id)),
    [goTo, items]
  )

  useEffect(() => {
    const onKeyDown = (event) => {
      // Never steal keys from an input or from a browser shortcut.
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'j') goTo(activeIndex + 1)
      else if (event.key === 'k') goTo(activeIndex - 1)
      else if (event.key === 'r' || event.key === 'R') refresh()
      else return

      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, goTo, refresh])

  const options = useMemo(
    () => ({ diffStyle, theme: 'github-dark', stickyHeaders: true }),
    [diffStyle]
  )

  const baseSource = {
    override: 'given on the command line',
    remembered: 'remembered',
    guessed: 'guessed',
    trunk: 'trunk',
  }[data?.base?.source]

  const activeId = entries[activeIndex]?.id

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
          <kbd>k</kbd> files · <kbd>r</kbd> refresh
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

      {!error && data && items.length === 0 && (
        <p className="message">
          Nothing to show — <code>{data.head.branch}</code> matches <code>{data.base.ref}</code>.
        </p>
      )}

      {items.length > 0 && (
        <div className="body">
          <aside className="sidebar">
            <div className="sidebar-head">
              <span>{stats.files} files</span>
              <span className="spacer" />
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

          {/* CodeView owns its scrolling. The style lands on its own scroller, so it
              needs both a real height (or it measures 0 and mounts nothing) and
              `overflowY: auto` — it only recomputes the virtual window from the
              element it scrolls itself, never from an ancestor. */}
          <div className="diff">
            <CodeView
              ref={viewRef}
              items={items}
              options={options}
              style={{ height: '100%', overflowY: 'auto' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
