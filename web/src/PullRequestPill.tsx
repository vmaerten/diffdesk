import { useEffect, useState } from 'react'
import Icon from './Icon.tsx'
import type { PullRequest, PullRequestPayload } from '../../src/types.ts'

/** Coming back to the window refreshes the pull request, at most this often. */
const FOCUS_REFRESH_MS = 30_000

const STATES: Record<
  PullRequest['state'],
  { icon: 'pr-open' | 'pr-draft' | 'pr-merged' | 'pr-closed'; label: string }
> = {
  open: { icon: 'pr-open', label: 'Open' },
  draft: { icon: 'pr-draft', label: 'Draft' },
  merged: { icon: 'pr-merged', label: 'Merged' },
  closed: { icon: 'pr-closed', label: 'Closed' },
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
const names = (logins: string[]) => logins.join(', ')

function reviews(pr: PullRequest): { tone: string; text: string } {
  const waiting = pr.requested.length > 0 ? ` · waiting for ${names(pr.requested)}` : ''
  if (pr.changesRequestedBy.length > 0)
    return { tone: 'bad', text: `Changes requested by ${names(pr.changesRequestedBy)}${waiting}` }
  if (pr.approvedBy.length > 0)
    return { tone: 'ok', text: `Approved by ${names(pr.approvedBy)}${waiting}` }
  if (pr.review === 'required') return { tone: 'warn', text: `Review required${waiting}` }
  return {
    tone: 'dim',
    text: pr.requested.length > 0 ? `Waiting for ${names(pr.requested)}` : 'No review yet',
  }
}

/** What GitHub has against what this checkout has, which is what ghl reviews. */
function pushed(pr: PullRequest, workingTree: boolean): { tone: string; text: string } {
  const extra = pr.uncommitted && workingTree ? ', plus uncommitted changes' : ''
  const { sync } = pr
  if (!sync)
    return {
      tone: 'warn',
      text: `GitHub has commits this checkout lacks: fetch to compare${extra}`,
    }
  if (sync.ahead > 0 && sync.behind > 0)
    return {
      tone: 'warn',
      text: `Diverged: ${plural(sync.ahead, 'local commit')}, ${sync.behind} on GitHub${extra}`,
    }
  if (sync.ahead > 0)
    return { tone: 'warn', text: `${plural(sync.ahead, 'local commit')} not on GitHub${extra}` }
  if (sync.behind > 0)
    return { tone: 'warn', text: `${plural(sync.behind, 'commit')} on GitHub not here${extra}` }
  return extra
    ? { tone: 'warn', text: `Up to date with GitHub${extra}` }
    : { tone: 'ok', text: 'Up to date with GitHub' }
}

/**
 * The reviewed branch's pull request, from the title bar.
 *
 * It arrives after the diff and never holds it up; without gh, signed out, or
 * without a pull request, nothing shows.
 */
export default function PullRequestPill({
  repoId,
  branch,
  loadId,
  workingTree,
}: {
  repoId: string | null
  /** The reviewed local branch; null when the target is not one. */
  branch: string | null
  /** Changes on every refresh of the review, which refreshes this too. */
  loadId: number
  workingTree: boolean
}) {
  const [shown, setShown] = useState<{ branch: string; pr: PullRequest | null } | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!repoId || !branch) return
    const controller = new AbortController()
    let fetchedAt = 0
    const load = async () => {
      fetchedAt = Date.now()
      try {
        const response = await fetch(
          `/r/${repoId}/api/pull-request?branch=${encodeURIComponent(branch)}`,
          { signal: controller.signal },
        )
        const body: PullRequestPayload = await response.json()
        setShown({ branch, pr: response.ok ? body.pullRequest : null })
      } catch {
        // Only a decoration: a failed lookup leaves the review as it was.
        if (!controller.signal.aborted) setShown({ branch, pr: null })
      }
    }
    void load()
    const onFocus = () => {
      if (Date.now() - fetchedAt > FOCUS_REFRESH_MS) void load()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      controller.abort()
      window.removeEventListener('focus', onFocus)
    }
  }, [repoId, branch, loadId])

  // The popover owns Escape while it is open, as the pickers do.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // Another branch's pull request is never shown while this one's loads.
  const pr = shown && shown.branch === branch ? shown.pr : null
  if (!pr) return null
  const state = STATES[pr.state]
  const active = pr.state === 'open' || pr.state === 'draft'
  const ahead = active ? (pr.sync?.ahead ?? 0) : 0
  const conflicting = active && pr.mergeable === 'conflicting'
  const label = [
    `Pull request #${pr.number}, ${state.label.toLowerCase()}`,
    ahead > 0 && `${plural(ahead, 'commit')} not pushed`,
    conflicting && 'conflicts with its base',
  ]
    .filter(Boolean)
    .join(', ')
  const review = reviews(pr)
  const sync = pushed(pr, workingTree)
  return (
    <span className="base-anchor">
      <button
        type="button"
        className="titlebar-button titlebar-text pr-pill"
        title={`${pr.title} (#${pr.number})`}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`pr-state ${pr.state}`}>
          <Icon name={state.icon} />
        </span>
        #{pr.number}
        {ahead > 0 && (
          <span className="pr-warning">
            <Icon name="arrow-up" />
            {ahead}
          </span>
        )}
        {conflicting && (
          <span className="pr-warning">
            <Icon name="alert" />
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="picker-backdrop" onMouseDown={() => setOpen(false)} />
          <div className="pr-popover" role="dialog" aria-label={`Pull request #${pr.number}`}>
            <div className="pr-head">
              <span className={`pr-badge ${pr.state}`}>
                <Icon name={state.icon} />
                {state.label}
              </span>
              <span className="pr-number">#{pr.number}</span>
              <a className="pr-link" href={pr.url} target="_blank" rel="noreferrer" autoFocus>
                Open on GitHub
                <Icon name="link-external" />
              </a>
            </div>
            <p className="pr-title">{pr.title}</p>
            <p className="pr-byline">
              {pr.author} · into <code>{pr.base}</code>
            </p>
            <dl className="pr-facts">
              <div className={review.tone}>
                <dt>Reviews</dt>
                <dd>{review.text}</dd>
              </div>
              {active ? (
                <>
                  <div
                    className={
                      pr.mergeable === 'conflicting'
                        ? 'bad'
                        : pr.mergeable === 'mergeable'
                          ? 'ok'
                          : 'dim'
                    }
                  >
                    <dt>Merge</dt>
                    <dd>
                      {pr.mergeable === 'conflicting'
                        ? `Conflicts with ${pr.base}`
                        : pr.mergeable === 'mergeable'
                          ? `No conflicts with ${pr.base}`
                          : 'GitHub is still checking for conflicts'}
                    </dd>
                  </div>
                  <div className={sync.tone}>
                    <dt>Pushed</dt>
                    <dd>{sync.text}</dd>
                  </div>
                </>
              ) : (
                <div className="dim">
                  <dt>Status</dt>
                  <dd>
                    {pr.state === 'merged' ? `Merged into ${pr.base}` : 'Closed without merging'}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </>
      )}
    </span>
  )
}
