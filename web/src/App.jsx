import { useCallback, useEffect, useMemo, useState } from 'react'
import { parsePatchFiles } from '@pierre/diffs'
import { CodeView } from '@pierre/diffs/react'

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

  /**
   * The single refresh path.
   *
   * Everything that reloads the diff goes through here — the button now, a
   * WebSocket later. Keeping it to one function is what makes the watcher a
   * ten-line change (discipline 4 in PLAN.md).
   */
  const refresh = useCallback(async () => {
    if (!repoId) return setError('no repository in the URL (expected /r/<repoId>)')
    try {
      const response = await fetch(`/r/${repoId}/api/diff`)
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setData(body)
      setError(null)
    } catch (cause) {
      setError(cause.message)
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
          Nothing to show — <code>{data.head.branch}</code> matches{' '}
          <code>{data.base.ref}</code>.
        </p>
      )}

      {/* CodeView owns its scrolling. The style lands on its own scroller, so it
          needs both a real height (or it measures 0 and mounts nothing) and
          `overflowY: auto` — it only recomputes the virtual window from the
          element it scrolls itself, never from an ancestor. */}
      {items.length > 0 && (
        <div className="diff">
          <CodeView
            items={items}
            options={options}
            style={{ height: '100%', overflowY: 'auto' }}
          />
        </div>
      )}
    </div>
  )
}
