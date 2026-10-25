import { useId, useRef, type ReactNode } from 'react'
import type { ServedComment } from '../../src/types.ts'
import type { SaveState } from './commentPersistence.ts'
import Icon from './Icon.tsx'

export const lineLabel = (start: number, end: number) =>
  start === end ? `L${start}` : `L${start}–L${end}`

export default function CommentCard({
  comment,
  currentRange,
  state,
  copied,
  onCopy,
  onEdit,
  onDelete,
  onResolve,
  onRetry,
  collapsed = false,
  onToggle,
  children,
}: {
  comment: ServedComment
  currentRange: string
  state?: SaveState
  copied: boolean
  onCopy: (comment: ServedComment) => void
  onEdit: (comment: ServedComment) => void
  onDelete: (id: string) => void
  onResolve: (id: string) => void
  onRetry: (comment: ServedComment) => void
  collapsed?: boolean
  onToggle?: () => void
  children?: ReactNode
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const contentId = useId()
  const closeMenu = () => {
    if (menu.current) menu.current.open = false
  }
  return (
    <article
      className={`comment${comment.stale ? ' stale' : ''}${collapsed ? ' collapsed' : ''}`}
      data-comment-id={comment.id}
    >
      <header>
        {onToggle ? (
          <button
            type="button"
            className="comment-collapse"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={contentId}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} comment at ${lineLabel(comment.start, comment.end)}`}
            title={collapsed ? 'Expand comment' : 'Collapse comment'}
          >
            <svg
              className="comment-chevron"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path
                d="m4 2 4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="comment-lines">{lineLabel(comment.start, comment.end)}</span>
            {collapsed && (
              <span className="comment-preview">{comment.body.replace(/\s+/g, ' ')}</span>
            )}
          </button>
        ) : (
          <span className="comment-lines">{lineLabel(comment.start, comment.end)}</span>
        )}
        {comment.stale && (
          <span className="badge" title="The code has changed since this comment was written">
            Lines changed
          </span>
        )}
        {!onToggle && <span className="spacer" />}
        {state === 'saving' && (
          <span className="comment-state" role="status">
            Saving…
          </span>
        )}
        {state === 'failed' && (
          <>
            <span className="comment-state failed" role="status">
              Not saved
            </span>
            <button type="button" onClick={() => onRetry(comment)}>
              Retry
            </button>
          </>
        )}
        <button
          type="button"
          className="comment-resolve"
          title="Close this comment and keep it"
          onClick={() => onResolve(comment.id)}
        >
          Resolve
        </button>
        <button
          type="button"
          className="comment-copy"
          onClick={() => onCopy(comment)}
          title="Copy comment with code"
          aria-label={copied ? 'Copied comment' : 'Copy comment'}
        >
          <Icon name="copy" />
          {copied && <span role="status">Copied</span>}
        </button>
        <details
          className="comment-menu"
          ref={menu}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeMenu()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menu.current?.open) {
              event.stopPropagation()
              closeMenu()
              menu.current.querySelector('summary')?.focus()
            }
          }}
        >
          <summary className="icon-button" aria-label="Comment actions">
            <Icon name="more" />
          </summary>
          <div className="comment-menu-items">
            <button
              type="button"
              onClick={() => {
                closeMenu()
                onEdit(comment)
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="danger-action"
              onClick={() => {
                closeMenu()
                onDelete(comment.id)
              }}
            >
              Delete
            </button>
          </div>
        </details>
      </header>
      <div id={contentId} hidden={collapsed}>
        {comment.range !== currentRange && (
          <div className="comment-provenance">
            Written in <code>{comment.range}</code>
          </div>
        )}
        <p>{comment.body}</p>
        {(comment.stale || comment.code.length === 0) && comment.anchor.length > 0 && (
          <details className="comment-original">
            <summary>Original code</summary>
            <pre className="comment-anchor" aria-label="the lines as they were">
              {comment.anchor.join('\n')}
            </pre>
          </details>
        )}
        {children}
      </div>
    </article>
  )
}
