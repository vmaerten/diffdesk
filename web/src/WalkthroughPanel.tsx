import { Fragment, type ReactNode } from 'react'
import type { ServedHunk, ServedWalkthrough, WalkthroughStop } from '../../src/types.ts'
import Icon from './Icon.tsx'

/** Every stop of a walkthrough, in reading order across its chapters. */
export const stopsOf = (walkthrough: ServedWalkthrough | null): WalkthroughStop[] =>
  walkthrough?.chapters.flatMap((chapter) => chapter.stops) ?? []

/** The guide allows inline code between backticks and nothing else. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>,
        )}
    </>
  )
}

function HunkRef({ hunk }: { hunk: ServedHunk }) {
  const id = hunk.at?.id ?? hunk.id
  const name = id.slice(id.lastIndexOf('/') + 1)
  return hunk.at ? (
    <span className="walkthrough-ref" title={id}>
      {name}
    </span>
  ) : (
    <span className="walkthrough-ref gone" title={`${id} is no longer in this diff`}>
      {name}
    </span>
  )
}

/**
 * The branch's walkthrough beside the diff: its chapters and stops, the current
 * one open with its prose. Choosing a stop scrolls the diff, which stays whole.
 */
export default function WalkthroughPanel({
  open,
  tabs,
  walkthrough,
  current,
  read,
  onStop,
  onStep,
  generating,
  onGenerate,
  onClose,
}: {
  open: boolean
  tabs: ReactNode
  walkthrough: ServedWalkthrough | null
  current: number
  read: ReadonlySet<number>
  onStop: (index: number) => void
  onStep: (by: number) => void
  /** The agent writing a walkthrough of this branch. */
  generating?: string
  /** Opens Generate Walkthrough; absent while generation is off in Settings. */
  onGenerate?: () => void
  onClose: () => void
}) {
  const stops = stopsOf(walkthrough)
  let index = 0
  return (
    <aside
      className="comments-panel inline walkthrough-panel"
      aria-label="Walkthrough"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="comments-panel-head">
        {tabs}
        <button className="icon-button" type="button" aria-label="Close panel" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {!walkthrough ? (
        <div className="comments-empty walkthrough-empty">
          <h3>No walkthrough yet</h3>
          {generating ? (
            <p role="status">
              <span className="install-spinner" aria-hidden="true" /> {generating} is writing one…
            </p>
          ) : (
            onGenerate && (
              <button type="button" className="button primary" onClick={onGenerate}>
                Generate Walkthrough…
              </button>
            )
          )}
          <p>
            Ask the agent that wrote the change for a tour of it. It learns how with the first
            command, then cites hunks and saves the tour:
          </p>
          <pre>
            diffdesk walkthrough guide{'\n'}diffdesk walkthrough hunks{'\n'}diffdesk walkthrough set
            tour.json
          </pre>
          <p>
            Press <kbd>r</kbd> to show it once saved.
          </p>
        </div>
      ) : (
        <>
          <div className="walkthrough-body">
            <div className="walkthrough-head">
              <h3>{walkthrough.title}</h3>
              {walkthrough.focus && (
                <p>
                  <Prose text={walkthrough.focus} />
                </p>
              )}
              <div className="walkthrough-meta">
                By {walkthrough.author} · {walkthrough.createdAt.slice(0, 10)} · {walkthrough.range}
                {walkthrough.workingTree && ' with the working tree'}
                {generating && ` · ${generating} is writing a new one…`}
                {onGenerate && !generating && (
                  <button type="button" className="link-button" onClick={onGenerate}>
                    Generate again…
                  </button>
                )}
              </div>
            </div>
            {walkthrough.stale ? (
              <p className="walkthrough-note" role="status">
                Half its hunks or more are gone from this diff: ask for a new walkthrough.
              </p>
            ) : (
              walkthrough.elsewhere && (
                <p className="walkthrough-note" role="status">
                  Written for another comparison; its hunks were found by their content.
                </p>
              )
            )}
            {walkthrough.chapters.map((chapter, c) => (
              <section key={c} className="walkthrough-chapter" aria-label={chapter.title}>
                <h4>{chapter.title}</h4>
                {chapter.stops.map((stop) => {
                  const i = index++
                  const gone = stop.hunks.some((hunk) => !hunk.at)
                  return (
                    <button
                      key={i}
                      type="button"
                      className="walkthrough-stop"
                      aria-current={i === current ? 'step' : undefined}
                      data-read={read.has(i) || undefined}
                      onClick={() => onStop(i)}
                    >
                      <span className="walkthrough-number">{read.has(i) ? '✓' : i + 1}</span>
                      <span className="walkthrough-stop-text">
                        <span className="walkthrough-stop-title">
                          {stop.title}
                          {gone && <span className="walkthrough-changed">Changed</span>}
                        </span>
                        <span className="walkthrough-summary">
                          <Prose text={stop.summary} />
                        </span>
                        {i === current && (
                          <>
                            {stop.prose && (
                              <span className="walkthrough-prose">
                                <Prose text={stop.prose} />
                              </span>
                            )}
                            <span className="walkthrough-refs">
                              {stop.hunks.map((hunk) => (
                                <HunkRef key={hunk.id} hunk={hunk} />
                              ))}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  )
                })}
              </section>
            ))}
            {(walkthrough.support.length > 0 || walkthrough.uncited.length > 0) && (
              <div className="walkthrough-support">
                {walkthrough.support.map((aside, i) => (
                  <p key={i}>
                    {aside.note} · {aside.hunks.length}{' '}
                    {aside.hunks.length === 1 ? 'hunk' : 'hunks'} off the path
                  </p>
                ))}
                {walkthrough.uncited.length > 0 && (
                  <p title={walkthrough.uncited.join('\n')}>
                    {walkthrough.uncited.length}{' '}
                    {walkthrough.uncited.length === 1 ? 'hunk' : 'hunks'} not in the walkthrough
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="walkthrough-foot">
            <span className="walkthrough-progress">
              <span className="walkthrough-bar">
                <i style={{ width: `${(100 * read.size) / Math.max(stops.length, 1)}%` }} />
              </span>
              {read.size}/{stops.length} read
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="Previous stop"
              title="Previous stop (p)"
              disabled={current <= 0}
              onClick={() => onStep(-1)}
            >
              <Icon name="chevron-left" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Next stop"
              title="Next stop (n)"
              disabled={current >= stops.length - 1}
              onClick={() => onStep(1)}
            >
              <Icon name="chevron-right" />
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
