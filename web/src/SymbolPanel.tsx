import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ReferencesAnswer, SymbolAnswer, SymbolQuery } from '../../src/types.ts'
import Icon from './Icon.tsx'
import { lookUpReferences, StaleSymbolError } from './codeIntelligence.ts'
import { treeOrder } from './fileOrder.ts'

export type PanelTab = 'comments' | 'symbol'

/** The symbol the Symbol tab shows: the token, and what its card already knows. */
export interface SymbolTarget {
  query: SymbolQuery
  answer: SymbolAnswer
}

/** Comments or Symbol, at the head of the side panel while code intelligence is on. */
export function PanelTabs({
  tab,
  comments,
  onTab,
}: {
  tab: PanelTab
  comments: number
  onTab: (tab: PanelTab) => void
}) {
  return (
    <div className="panel-tabs" role="tablist" aria-label="Side panel">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'comments'}
        onClick={() => onTab('comments')}
      >
        Comments <span className="counter">{comments}</span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'symbol'}
        onClick={() => onTab('symbol')}
      >
        Symbol
      </button>
      <span className="beta-badge">Beta</span>
    </div>
  )
}

type References =
  | { status: 'loading' }
  | { status: 'done'; answer: ReferencesAnswer }
  | { status: 'error'; message: string }

/**
 * A symbol's definition and references, beside the diff.
 *
 * A reference the diff displays opens there; the others show their line only,
 * as a comment outside the current diff does.
 */
export default function SymbolPanel({
  open,
  repoId,
  target,
  refresh,
  tabs,
  canReveal,
  onReveal,
  onClose,
}: {
  open: boolean
  repoId: string | null
  target: SymbolTarget | null
  /** A new load of the review asks again: the references may have moved. */
  refresh: number | undefined
  tabs: ReactNode
  canReveal: (path: string, line: number) => boolean
  onReveal: (path: string, line: number) => void
  onClose: () => void
}) {
  const [references, setReferences] = useState<References | null>(null)
  const [inDiffOnly, setInDiffOnly] = useState(false)
  const query = target?.query
  useEffect(() => {
    if (!open || !repoId || !query) return
    const controller = new AbortController()
    setReferences({ status: 'loading' })
    const load = async () => {
      try {
        setReferences({
          status: 'done',
          answer: await lookUpReferences(repoId, query, controller.signal),
        })
      } catch (cause) {
        if (controller.signal.aborted) return
        setReferences({
          status: 'error',
          message:
            cause instanceof StaleSymbolError
              ? 'This file changed on disk since the review loaded. Press r to refresh.'
              : String(cause instanceof Error ? cause.message : cause),
        })
      }
    }
    void load()
    return () => controller.abort()
  }, [open, repoId, query, refresh])

  const groups = useMemo(() => {
    if (references?.status !== 'done') return []
    const shown = references.answer.references.filter(
      (reference) => !inDiffOnly || canReveal(reference.path, reference.line),
    )
    const order = treeOrder([...new Set(shown.map((reference) => reference.path))])
    const byPath = new Map<string, typeof shown>()
    for (const reference of shown.toSorted(
      (a, b) => order.get(a.path)! - order.get(b.path)! || a.line - b.line,
    )) {
      byPath.set(reference.path, [...(byPath.get(reference.path) ?? []), reference])
    }
    return [...byPath]
  }, [references, inDiffOnly, canReveal])

  const definition =
    target?.answer.definitions.find((found) => found.inRepo) ?? target?.answer.definitions[0]
  const signature = target?.answer.hover.find((block) => block.kind === 'code')
  const total = references?.status === 'done' ? references.answer.references.length : null

  return (
    <aside
      className="comments-panel inline symbol-panel"
      aria-label="Symbol"
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
      {!target ? (
        <div className="comments-empty">
          <h3>No symbol yet</h3>
          <p>
            Hold <kbd>⌘</kbd> over a symbol in the diff and choose References.
          </p>
        </div>
      ) : (
        <div className="symbol-panel-body">
          <div className="symbol-panel-name">
            <b>{target.query.token}</b>
            <span>{target.answer.server}</span>
          </div>
          {definition && (
            <div className="symbol-panel-location">
              {definition.inRepo
                ? `${definition.path}:${definition.line}`
                : `Outside the repository: ${definition.path}`}
            </div>
          )}
          {signature && <pre className="symbol-signature">{signature.text}</pre>}
          <div className="symbol-panel-references-head">
            <span>References {total !== null && <span className="counter">{total}</span>}</span>
            <label>
              <input
                type="checkbox"
                checked={inDiffOnly}
                onChange={(event) => setInDiffOnly(event.target.checked)}
              />
              In this diff only
            </label>
          </div>
          {references?.status === 'loading' && (
            <p className="symbol-card-status">Asking {target.answer.server}…</p>
          )}
          {references?.status === 'error' && (
            <p className="symbol-card-status unavailable" role="alert">
              {references.message}
            </p>
          )}
          {references?.status === 'done' && total === 0 && (
            <p className="symbol-card-status">No references in this repository.</p>
          )}
          {groups.map(([path, list]) => (
            <section className="symbol-references" key={path} aria-label={path}>
              <h3>
                <span>{path}</span>
                <span className="counter">{list.length}</span>
              </h3>
              {list.map((reference) => {
                const displayed = canReveal(reference.path, reference.line)
                return (
                  <button
                    key={`${reference.line}:${reference.character}`}
                    type="button"
                    className="symbol-reference"
                    disabled={!displayed}
                    title={displayed ? 'Show in the diff' : 'Outside the current diff'}
                    onClick={() => onReveal(reference.path, reference.line)}
                  >
                    <i>{reference.line}</i>
                    <span>{reference.text.trim()}</span>
                    {displayed && <span className="symbol-tag">in diff</span>}
                  </button>
                )
              })}
            </section>
          ))}
          {references?.status === 'done' &&
            (references.answer.external > 0 || references.answer.truncated) && (
              <p className="symbol-card-status">
                {references.answer.truncated && 'Only the first 500 are listed. '}
                {references.answer.external > 0 &&
                  `${references.answer.external} more outside the repository.`}
              </p>
            )}
        </div>
      )}
    </aside>
  )
}
