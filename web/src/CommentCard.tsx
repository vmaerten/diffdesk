import { useRef, type ReactNode } from 'react'
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
  onRetry,
  children,
}: {
  comment: ServedComment
  currentRange: string
  state?: SaveState
  copied: boolean
  onCopy: (comment: ServedComment) => void
  onEdit: (comment: ServedComment) => void
  onDelete: (id: string) => void
  onRetry: (comment: ServedComment) => void
  children?: ReactNode
}) {
  const menu = useRef<HTMLDetailsElement>(null)
  const closeMenu = () => {
    if (menu.current) menu.current.open = false
  }
  return (
    <article className={comment.stale ? 'comment stale' : 'comment'} data-comment-id={comment.id}>
      <header>
        <span className="comment-lines">{lineLabel(comment.start, comment.end)}</span>
        {comment.stale && (
          <span className="badge" title="The code has changed since this comment was written">
            Lines changed
          </span>
        )}
        <span className="spacer" />
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
    </article>
  )
}
