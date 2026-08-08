import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  getFiletypeFromFileName,
  parsePatchFiles,
  type CodeViewDiffItem,
  type CodeViewItem,
} from '@pierre/diffs'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'

import RefSelector from './RefSelector.tsx'
import FileTree, { type FileTreeHandle, type TreeEntry } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import type { BaseSource, DiffPayload, ViewedMap } from '../../src/types.ts'

/**
 * `CodeViewDiffItem` carries no path; we add one and read it back from our own
 * array, which the library ignores.
 */
type DiffItem = CodeViewDiffItem & { path: string }

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

/** Well under the server's idle threshold, and cheap enough to be invisible. */
const HEARTBEAT_MS = 5 * 60_000

/** A fetch that never reached anything rejects with a TypeError, not an HTTP status. */
const NOT_LISTENING = 'ghl is no longer listening — run `ghl` again in that repository'

export default function App() {
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState<DiffPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [activeIndex, setActiveIndex] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  /** path -> hash of the diff section that was marked as read. */
  const [viewed, setViewedState] = useState<ViewedMap>({})
  const [picking, setPicking] = useState<'base' | 'target' | null>(null)
  /** Revision under review. null means the working tree of this checkout. */
  const [target, setTarget] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('target'),
  )
  const viewRef = useRef<CodeViewHandle<undefined>>(null)
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef<FileTreeHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)

  /**
   * The single refresh path.
   *
   * Everything that reloads the diff goes through here — the R key now, a
   * watcher later, which is what keeps that a ten-line change.
   */
  const refresh = useCallback(async () => {
    if (!repoId) {
      setError('no repository in the URL (expected /r/<repoId>)')
      return
    }
    setRefreshing(true)
    try {
      const query = target ? `?target=${encodeURIComponent(target)}` : ''
      const response = await fetch(`/r/${repoId}/api/diff${query}`)
      const body: DiffPayload & { error?: string } = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setData(body)
      // The server already dropped ticks whose file changed since.
      setViewedState(body.viewed ?? {})
      setError(null)
    } catch (cause) {
      if (cause instanceof TypeError) setError(NOT_LISTENING)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRefreshing(false)
    }
  }, [repoId, target])

  useEffect(() => {
    refresh()
  }, [refresh])

  /**
   * Say we are still here, while we are still here.
   *
   * One process now serves every repository and stops on its own once nothing
   * watches it. Reading a long diff sends no request at all, so without this it
   * would stop under an open tab — the heartbeat is what makes the threshold
   * mean "no tab" rather than "no click".
   */
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === 'visible') fetch('/api/health').catch(() => {})
    }
    const timer = setInterval(beat, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [])

  /** Review another revision. Kept in the URL so a reload stays on it. */
  const pickTarget = useCallback((ref: string | null) => {
    setPicking(null)
    setTarget(ref)
    const url = new URL(location.href)
    if (ref) url.searchParams.set('target', ref)
    else url.searchParams.delete('target')
    history.replaceState(null, '', url)
  }, [])

  /** Every file in the diff, in patch order. */
  const allItems = useMemo((): DiffItem[] => {
    if (!data?.patch) return []
    return parsePatchFiles(data.patch, `${repoId}-${data.head.sha}`)
      .flatMap((patch) => patch.files ?? [])
      .map((fileDiff, index) => ({
        id: fileDiff.cacheKey ?? `file-${index}`,
        path: fileDiff.name,
        type: 'diff' as const,
        // A rename that changes the extension asks for the grammar of the *old*
        // name, which is never preloaded — the file then throws and renders as
        // nothing at all. Pinning the language to the new name is what the
        // result should be anyway, and it is the only side that is loaded.
        fileDiff:
          fileDiff.prevName &&
          getFiletypeFromFileName(fileDiff.prevName) !== getFiletypeFromFileName(fileDiff.name)
            ? { ...fileDiff, lang: getFiletypeFromFileName(fileDiff.name) }
            : fileDiff,
      }))
  }, [data, repoId])

  /**
   * What CodeView renders: every file, the viewed ones folded shut.
   *
   * As GitHub does it. Removing them from the array instead — which is what this
   * used to do — changed the item list on every tick, and the pane rebuilds its
   * virtual window from scratch when that happens: the reader was thrown back to
   * the top of the diff each time, and a file clicked in the tree came back
   * somewhere they never saw. See decision 7 in PLAN.md for what it costs.
   */
  const versions = useRef(new Map<string, { collapsed: boolean; version: number }>())
  const items = useMemo(
    () =>
      allItems.map((item) => {
        const collapsed = item.path in viewed
        // The pane re-reads an item only when its `version` moves; flipping
        // `collapsed` on its own is accepted and then ignored, silently, which
        // is how a file could be ticked and never fold.
        const previous = versions.current.get(item.path)
        const version =
          previous === undefined || previous.collapsed === collapsed
            ? (previous?.version ?? 0)
            : previous.version + 1
        versions.current.set(item.path, { collapsed, version })
        return { ...item, collapsed, version }
      }),
    [allItems, viewed],
  )

  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = Object.keys(viewed).length

  const untrackedSet = useMemo(() => new Set(data?.untracked ?? []), [data])

  /** Tree entries: every file, viewed or not, enriched with git's per-file counts. */
  const entries = useMemo((): TreeEntry[] => {
    const byPath = new Map((data?.files ?? []).map((f) => [f.path, f] as const))
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
    async (path: string, next: boolean) => {
      if (!data) return
      const hash = data.files.find((f) => f.path === path)?.hash ?? null
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
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(`could not save viewed state: ${detail}`)
      }
    },
    [data, repoId],
  )

  const resetViewed = useCallback(async () => {
    if (!data) return
    setViewedState({})
    await fetch(`/r/${repoId}/api/viewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ range: data.range, clear: true }),
    })
  }, [data, repoId])

  /** Remember the chosen base for this branch, then reload against it. */
  const pickBase = useCallback(
    async (base: string | null) => {
      setPicking(null)
      if (!base || base === data?.base?.ref) return
      await fetch(`/r/${repoId}/api/base`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base, target }),
      })
      await refresh()
    },
    [data, repoId, refresh, target],
  )

  /** Navigation walks the rendered items — what is left to read. */
  const goTo = useCallback(
    (index: number) => {
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
    [items],
  )

  /** Every file is in the list now, viewed or not, so a click always lands. */
  const selectByPath = useCallback(
    (path: string) => goTo(items.findIndex((item) => item.path === path)),
    [items, goTo],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal keys from an input or from a browser shortcut.
      // Not `target`: that name already means the revision under review.
      const focused = event.target
      const tag = focused instanceof HTMLElement ? focused.tagName : null
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (focused instanceof HTMLElement && focused.isContentEditable) return
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

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  const options = useMemo(
    () => ({ diffStyle, theme: 'github-dark' as const, stickyHeaders: true }),
    [diffStyle],
  )

  /**
   * The Viewed control lives in the library's own file header.
   *
   * It has to be rebuilt when `viewed` changes. Holding it stable and reading
   * through refs keeps the pane from rebuilding, but the header is then never
   * rendered again: the box never ticks, and un-viewing from it is impossible
   * because the handler still closes over the value it was built with.
   */
  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<undefined>) => {
      const path = item.type === 'diff' ? item.fileDiff.name : null
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
    [viewed, toggleViewed],
  )

  const baseSources: Record<BaseSource, string> = {
    override: 'given on the command line',
    remembered: 'remembered',
    guessed: 'guessed',
    trunk: 'trunk',
  }
  const baseSource = data ? baseSources[data.base.source] : null

  const activePath = items[activeIndex]?.path

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

      {data && data.untracked.length > 0 && !data.untrackedIncluded && (
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
        <div
          className="body"
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar">
            <div className="sidebar-head">
              <span>
                {viewedCount > 0
                  ? `${viewedCount}/${entries.length} viewed`
                  : `${entries.length} files`}
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

          {/* CodeView owns its scrolling. The style lands on its own scroller, so it
              needs both a real height (or it measures 0 and mounts nothing) and
              `overflowY: auto` — it only recomputes the virtual window from the
              element it scrolls itself, never from an ancestor.

              Nothing conditional above it inside `.diff`: a sibling appearing or
              disappearing shifts CodeView's position among its parent's children,
              and React remounts it — losing the scroll along with it. */}
          <div className="diff">
            <CodeView
              ref={viewRef}
              items={items}
              options={options}
              renderHeaderMetadata={renderHeaderMetadata}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
