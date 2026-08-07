import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { resolveTheme } from '@pierre/diffs'
import { themeToTreeStyles } from '@pierre/trees'
import { FileTree as TreeView, useFileTree } from '@pierre/trees/react'

/** Same palette as the diff pane, so counts read identically on both sides. */
const ADDED = '#3fb950'
const DELETED = '#f85149'
const MUTED = '#8b949e'

/**
 * Every directory a file sits under, as the tree addresses them.
 *
 * Directory ids carry a trailing slash — `src/`, not `src` — and a flattened
 * chain is one node named after its deepest segment (`web/src/`). Producing the
 * whole chain of prefixes therefore covers both the plain and the flattened case.
 */
const ancestorDirs = (path) => {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`)
}

/**
 * Aggregate counts per directory.
 *
 * A folded directory has to say how much it hides, and the library only hands
 * the renderer one row at a time — so the totals are precomputed here.
 */
function directoryTotals(entries) {
  const totals = new Map()
  for (const entry of entries) {
    for (const dir of ancestorDirs(entry.path)) {
      const current = totals.get(dir) ?? { files: 0, additions: 0, deletions: 0 }
      current.files += 1
      current.additions += entry.additions
      current.deletions += entry.deletions
      totals.set(dir, current)
    }
  }
  return totals
}

/** Join coloured parts into the plain string the row also needs. */
const asText = (parts) => ({
  text: parts.map((part) => part.text).join(''),
  parts,
})

/**
 * The changed-file tree.
 *
 * Wraps `@pierre/trees`, which renders into a shadow DOM and virtualises its
 * rows. Two consequences drive the shape of this file:
 *
 *  - `useFileTree` reads its options once, at construction. Everything that
 *    changes afterwards — the entries, the decorations, the click handler —
 *    has to reach the model imperatively or through a ref, never as a prop.
 *  - only one decoration fits per row, and it is text or an icon, not a node.
 *    The viewed tick and the +/- counts therefore share a single string.
 */
function FileTree({ entries, activePath, onSelect }, ref) {
  const [themeStyles, setThemeStyles] = useState(null)

  // Read by callbacks the model captured at construction, so they always see
  // the current render's data rather than the first one's.
  const entriesRef = useRef(new Map())
  const onSelectRef = useRef(onSelect)
  const totalsRef = useRef(new Map())
  /** Directories the reader folded, so a refresh does not unfold them all. */
  const collapsedRef = useRef(new Set())
  /** Set while we drive the selection ourselves, to not echo it back to App. */
  const syncingRef = useRef(false)

  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries])
  entriesRef.current = byPath
  onSelectRef.current = onSelect
  totalsRef.current = useMemo(() => directoryTotals(entries), [entries])

  const { model } = useFileTree({
    paths: entries.map((e) => e.path),
    icons: { set: 'complete', colored: true },
    density: 'compact',
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    onSelectionChange: (paths) => {
      if (syncingRef.current) return
      const path = paths[paths.length - 1]
      if (path && !model.getItem(path)?.isDirectory()) onSelectRef.current?.(path)
    },
    renderRowDecoration: ({ row }) => {
      if (row.kind === 'directory') {
        // Only worth saying when the directory hides its contents.
        if (row.isExpanded) return null
        const totals = totalsRef.current.get(row.path)
        if (!totals) return null
        const label = `${totals.files} ${totals.files > 1 ? 'files' : 'file'}`
        return asText([{ text: label, color: MUTED }])
      }

      const entry = entriesRef.current.get(row.path)
      if (!entry) return null

      const parts = []
      if (entry.viewed) parts.push({ text: '✓ ', color: ADDED })
      if (entry.binary) parts.push({ text: 'bin', color: MUTED })
      else {
        if (entry.additions > 0) parts.push({ text: `+${entry.additions}`, color: ADDED })
        if (entry.deletions > 0) parts.push({ text: ` −${entry.deletions}`, color: DELETED })
      }
      return parts.length > 0 ? asText(parts) : null
    },
  })

  // github-dark is what the diff pane uses; the tree reads the same resolved
  // theme so both panes agree on every colour but the ones we override below.
  useEffect(() => {
    let cancelled = false
    resolveTheme('github-dark').then((theme) => {
      if (!cancelled) setThemeStyles(themeToTreeStyles(theme))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** Expand every directory on the way to `path`, or scrollToPath finds nothing. */
  const reveal = useCallback(
    (path) => {
      for (const dir of ancestorDirs(path)) {
        const item = model.getItem(dir)
        if (item?.isDirectory() && !item.isExpanded()) {
          item.expand()
          collapsedRef.current.delete(dir)
        }
      }
      model.scrollToPath(path, { focus: false, offset: 'nearest' })
    },
    [model]
  )

  /**
   * Fold or unfold everything.
   *
   * Folding walks the rows backwards so children close before their parents,
   * which keeps a later unfold of one directory from spilling its whole subtree.
   */
  const setAllExpanded = useCallback(
    (expanded) => {
      for (let pass = 0; pass < 64; pass++) {
        const rows = model.getVisibleRows(0, model.getVisibleCount())
        const dirs = rows.filter((row) => row.kind === 'directory' && row.isExpanded !== expanded)
        if (dirs.length === 0) break
        for (const row of expanded ? dirs : dirs.reverse()) {
          const item = model.getItem(row.path)
          if (!item?.isDirectory()) continue
          if (expanded) {
            item.expand()
            collapsedRef.current.delete(row.path)
          } else {
            item.collapse()
            collapsedRef.current.add(row.path)
          }
        }
        // Folding needs a single pass: closing a parent cannot reveal anything.
        if (!expanded) break
      }
    },
    [model]
  )

  useImperativeHandle(
    ref,
    () => ({
      reveal,
      expandAll: () => setAllExpanded(true),
      collapseAll: () => setAllExpanded(false),
    }),
    [reveal, setAllExpanded]
  )

  // Track folds as they happen: a directory nested inside a folded one stops
  // being visible, so the set has to be maintained live rather than read back.
  useEffect(
    () =>
      model.subscribe(() => {
        for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
          if (row.kind !== 'directory') continue
          if (row.isExpanded) collapsedRef.current.delete(row.path)
          else collapsedRef.current.add(row.path)
        }
      }),
    [model]
  )

  // Keyed by content, not by identity: `entries` is rebuilt on every viewed
  // toggle, and resetting the tree there would throw away every fold.
  const pathKey = entries.map((e) => e.path).join('\n')
  const paths = useMemo(() => (pathKey ? pathKey.split('\n') : []), [pathKey])

  // The model was built with the first render's paths; every later diff has to
  // be pushed in. Folds are restored by hand, since reset only takes expanded
  // ones — and from a copy, because reset notifies the subscriber above, which
  // sees every directory back open and empties the set before we can read it.
  useEffect(() => {
    const folded = [...collapsedRef.current]
    model.resetPaths(paths)
    for (const path of folded) {
      const item = model.getItem(path)
      if (item?.isDirectory()) item.collapse()
    }
  }, [model, paths])

  useEffect(() => {
    model.setGitStatus(entries.map((e) => ({ path: e.path, status: e.status ?? 'modified' })))
  }, [model, entries])

  // Decorations are read during render and the model has no idea they changed,
  // so a viewed tick or a new count needs an explicit repaint.
  useEffect(() => {
    model.setComposition(model.getComposition())
  }, [model, entries])

  // Selection is the tree's own highlight; App owns which file is current.
  // `select()` adds to the selection rather than replacing it, so the previous
  // row has to be dropped by hand or every visited file stays lit.
  useEffect(() => {
    syncingRef.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== activePath) model.getItem(path)?.deselect()
      }
      if (activePath) model.getItem(activePath)?.select()
    } finally {
      syncingRef.current = false
    }
  }, [model, activePath])

  const style = useMemo(
    () => ({
      flex: 1,
      minHeight: 0,
      ...themeStyles,
      // github-dark's own sidebar colour is a shade off ours, which shows as a
      // seam under the header. Both surfaces are told to use the same one.
      '--trees-theme-sidebar-bg': 'var(--bg-raised)',
    }),
    [themeStyles]
  )

  return <TreeView model={model} className="tree" style={style} aria-label="Changed files" />
}

export default forwardRef(FileTree)
