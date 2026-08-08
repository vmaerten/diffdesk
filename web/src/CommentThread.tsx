import { useRef, type RefObject } from 'react'

import type { Comment } from '../../src/types.ts'

/** Where a comment is being written, or which one is being rewritten. */
export interface Composer {
  /** The annotation this belongs to: path, side and anchor line. */
  key: string
  path: string
  side: 'deletions' | 'additions'
  start: number
  end: number
  /** Id of the comment being edited, or null when writing a new one. */
  editing: string | null
}

/** How a comment's last write went. Absent means the server has it. */
export type SaveState = 'saving' | 'failed'

interface Props {
  comments: Comment[]
  composing: Composer | null
  /** What the diff on screen compares, to spot comments written against another. */
  currentRange: string
  saving: Map<string, SaveState>
  /**
   * Drafts, held outside this component on purpose.
   *
   * The pane drops an item's element once it leaves the virtual window, which
   * unmounts this card — a draft kept in its own state would be lost to a scroll.
   */
  drafts: RefObject<Map<string, string>>
  onSubmit: (body: string) => void
  onCancel: () => void
  onEdit: (comment: Comment) => void
  onDelete: (id: string) => void
  onRetry: (comment: Comment) => void
}

const lineLabel = (start: number, end: number) =>
  start === end ? `L${start}` : `L${start}–L${end}`

export default function CommentThread({
  comments,
  composing,
  currentRange,
  saving,
  drafts,
  onSubmit,
  onCancel,
  onEdit,
  onDelete,
  onRetry,
}: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const draftKey = composing ? `${composing.key}:${composing.editing ?? 'new'}` : ''

  const submit = () => {
    const body = area.current?.value.trim() ?? ''
    if (body) onSubmit(body)
  }

  return (
    <div className="comment-thread">
      {comments.map((comment) => {
        const state = saving.get(comment.id)
        // Hidden while its own editor is open, or the card would show the text
        // twice — once as it is stored, once as it is being rewritten.
        if (composing?.editing === comment.id) return null
        return (
          <article key={comment.id} className="comment">
            <header>
              <span className="comment-lines">{lineLabel(comment.start, comment.end)}</span>
              {/* Comments are filed against code, not against a comparison, so
                  one written under another base can legitimately show up here.
                  Said out loud rather than hidden — its line numbers came from a
                  diff this is not. */}
              {comment.range !== currentRange && (
                <span
                  className="comment-elsewhere"
                  title={`Written while reviewing ${comment.range}`}
                >
                  from {comment.range}
                </span>
              )}
              <span className="spacer" />
              {state === 'saving' && <span className="comment-state">saving…</span>}
              {state === 'failed' && (
                <>
                  <span className="comment-state failed">not saved</span>
                  <button type="button" onClick={() => onRetry(comment)}>
                    Retry
                  </button>
                </>
              )}
              <button type="button" onClick={() => onEdit(comment)}>
                Edit
              </button>
              <button type="button" onClick={() => onDelete(comment.id)}>
                Delete
              </button>
            </header>
            <p>{comment.body}</p>
          </article>
        )
      })}

      {composing && (
        <div className="comment-composer">
          <label>
            <span className="comment-lines">{lineLabel(composing.start, composing.end)}</span>
            <textarea
              // Keyed by target: remounting is what re-reads defaultValue, so an
              // uncontrolled field follows the composer from one line to the next.
              key={draftKey}
              ref={area}
              rows={4}
              autoFocus
              placeholder="What should change here?"
              defaultValue={drafts.current?.get(draftKey) ?? ''}
              // Into the ref, not into state: a keystroke must not re-render the
              // application, and the pane re-measures items only on its own passes.
              onChange={(event) => drafts.current?.set(draftKey, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  // The global handler treats Escape as nothing, but the picker
                  // pattern is to stop it here rather than rely on that.
                  event.stopPropagation()
                  onCancel()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </label>
          <footer>
            <span className="hint">
              <kbd>⌘</kbd>
              <kbd>↵</kbd> save · <kbd>esc</kbd> cancel
            </span>
            <span className="spacer" />
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submit}>
              {composing.editing ? 'Update' : 'Comment'}
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
