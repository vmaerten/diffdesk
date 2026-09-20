import { useEffect, useState } from 'react'
import { Command } from 'cmdk'

import type { CommitDetail, CommitsPayload } from '../../src/types.ts'

interface CommitSelectorProps {
  repoId: string | null
  /** The same selection as the diff, including an explicit base. */
  query: string
  /** The commit being shown, or null for the whole range. */
  current: CommitDetail | null
  onPick: (sha: string | null) => void
  onClose: () => void
}

/**
 * Picker for one commit of the range — GitHub's "Showing changes from".
 *
 * A sibling of `RefSelector` rather than a generalisation of it: the two fetch
 * different things, badge different things and mean different things, and what
 * they share is the shell. They do share the CSS.
 */
export default function CommitSelector({
  repoId,
  query,
  current,
  onPick,
  onClose,
}: CommitSelectorProps) {
  const [commits, setCommits] = useState<CommitDetail[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch(`/r/${repoId}/api/commits${query}`)
        const body: CommitsPayload & { error?: string } = await response.json()
        if (cancelled) return
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        setCommits(body.commits)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoId, query])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // The base can have moved since the commit was picked, or the branch grown a
  // new tip: the selection is kept and marked rather than dropped, since its
  // diff is the same one either way.
  const outOfRange = Boolean(current && commits && !commits.some((c) => c.sha === current.sha))

  return (
    <>
      <div className="picker-backdrop" onMouseDown={onClose} />
      <div className="picker" onMouseDown={(event) => event.stopPropagation()}>
        <Command label="Choose a commit" loop>
          <Command.Input autoFocus placeholder="Search commits…" className="picker-input" />

          <Command.List className="picker-list">
            {error && <div className="picker-empty">{error}</div>}
            {!commits && !error && <div className="picker-empty">Loading commits…</div>}
            <Command.Empty className="picker-empty">No matching commit.</Command.Empty>

            <Command.Item
              value="__all__ all commits every commit"
              onSelect={() => onPick(null)}
              className="picker-item"
            >
              <span className="picker-name">All commits</span>
              <span className="picker-when">the whole range</span>
            </Command.Item>

            {outOfRange && current && (
              <Command.Item
                value={`${current.short} ${current.subject}`}
                onSelect={() => onPick(current.sha)}
                className="picker-item"
              >
                <code className="picker-sha">{current.short}</code>
                <span className="picker-name">{current.subject}</span>
                <span className="badge on">outside this range</span>
                <span className="picker-when">{current.when}</span>
              </Command.Item>
            )}

            {(commits ?? []).map((commit) => (
              <Command.Item
                key={commit.sha}
                value={`${commit.short} ${commit.subject} ${commit.author}`}
                onSelect={() => onPick(commit.sha)}
                className="picker-item"
              >
                <code className="picker-sha">{commit.short}</code>
                <span className="picker-name">{commit.subject}</span>
                {commit.parents.length > 1 && <span className="badge">merge</span>}
                {commit.sha === current?.sha && <span className="badge on">shown</span>}
                {/* Absent on a merge, and on a commit that changes nothing:
                    `--shortstat` says nothing about either. */}
                {commit.additions !== null && (
                  <span className="picker-counts">
                    <span className="add">+{commit.additions}</span>{' '}
                    <span className="del">−{commit.deletions}</span>
                  </span>
                )}
                <span className="picker-when">{commit.when}</span>
              </Command.Item>
            ))}
          </Command.List>

          <div className="picker-foot">
            showing: <code>{current ? current.short : 'all commits'}</code> · <kbd>↵</kbd> pick ·{' '}
            <kbd>esc</kbd> close
          </div>
        </Command>
      </div>
    </>
  )
}
