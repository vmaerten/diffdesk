import { useEffect, useMemo, useState, type RefObject } from 'react'
import type { ServedComment } from '../../src/types.ts'
import type { SaveState } from './commentPersistence.ts'
import CommentCard, { lineLabel } from './CommentCard.tsx'
import Icon from './Icon.tsx'
import { treeOrder } from './fileOrder.ts'

export default function CommentsPanel({
  savedEditor,
  open,
  comments,
  currentRange,
  saving,
  copied,
  copyError,
  onClose,
  onCopy,
  onView,
  canView,
  onUpdate,
  onDelete,
  onRetry,
}: {
  savedEditor?: RefObject<{ editing: string | null; draft: string }>
  open: boolean
  comments: ServedComment[]
  currentRange: string
  saving: Map<string, SaveState>
  copied: string | null
  copyError: string | null
  onClose: () => void
  onCopy: (comment?: ServedComment) => void
  onView: (comment: ServedComment) => void
  canView: (comment: ServedComment) => boolean
  onUpdate: (comment: ServedComment, body: string) => void
  onDelete: (id: string) => void
  onRetry: (comment: ServedComment) => void
}) {
  const [editing, setEditing] = useState<string | null>(savedEditor?.current.editing ?? null)
  const [draft, setDraft] = useState(savedEditor?.current.draft ?? '')
  useEffect(() => {
    if (savedEditor) savedEditor.current = { editing, draft }
  }, [savedEditor, editing, draft])
  const groups = useMemo(() => {
    const result = new Map<string, ServedComment[]>()
    // Files in the tree's order, so the panel reads in the same sequence.
    const order = treeOrder([...new Set(comments.map((comment) => comment.path))])
    for (const comment of comments.toSorted(
      (a, b) =>
        order.get(a.path)! - order.get(b.path)! ||
        a.start - b.start ||
        a.createdAt.localeCompare(b.createdAt),
    )) {
      const group = result.get(comment.path) ?? []
      group.push(comment)
      result.set(comment.path, group)
    }
    return [...result]
  }, [comments])
  const update = (comment: ServedComment) => {
    if (!draft.trim()) return
    onUpdate(comment, draft.trim())
    setEditing(null)
  }
  const toolbar = (
    <div className="comments-panel-toolbar">
      <button
        type="button"
        className="button primary"
        disabled={comments.length === 0}
        onClick={() => onCopy()}
      >
        <Icon name="copy" />
        {copied === 'all' ? 'Copied' : 'Copy all as Markdown'}
        <kbd>⇧⌘C</kbd>
      </button>
    </div>
  )
  const content = (
    <>
      <div className="comments-panel-head">
        <h2 id="comments-title">
          <Icon name="comment" /> Comments <span className="counter">{comments.length}</span>
        </h2>
        <button className="icon-button" type="button" aria-label="Close comments" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {copyError && (
        <p className="warning" role="alert">
          {copyError}
        </p>
      )}
      <div className="comments-panel-list">
        {groups.length === 0 && (
          <div className="comments-empty">
            <Icon name="comment" />
            <h3>No comments yet</h3>
            <p>
              Select lines in the diff and press <kbd>c</kbd>, or use the + in the gutter to leave a
              comment.
            </p>
          </div>
        )}
        {open &&
          groups.map(([path, group]) => (
            <section className="comment-file" key={path} aria-label={path}>
              <h3>
                <Icon name="file" />
                <span>{path}</span>
                <span className="counter">{group.length}</span>
              </h3>
              {group.map((comment) =>
                editing === comment.id ? (
                  <form
                    key={comment.id}
                    className="panel-editor"
                    onSubmit={(event) => {
                      event.preventDefault()
                      update(comment)
                    }}
                  >
                    <label>
                      Edit comment · {lineLabel(comment.start, comment.end)}
                      <textarea
                        autoFocus
                        rows={5}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                            event.preventDefault()
                            update(comment)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            setEditing(null)
                          }
                        }}
                      />
                    </label>
                    <footer>
                      <button type="button" className="button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button type="submit" className="button primary" disabled={!draft.trim()}>
                        Update
                      </button>
                    </footer>
                  </form>
                ) : (
                  <CommentCard
                    key={comment.id}
                    comment={comment}
                    currentRange={currentRange}
                    state={saving.get(comment.id)}
                    copied={copied === comment.id}
                    onCopy={onCopy}
                    onEdit={(item) => {
                      setEditing(item.id)
                      setDraft(item.body)
                    }}
                    onDelete={onDelete}
                    onRetry={onRetry}
                  >
                    <footer className="comment-navigation">
                      {canView(comment) ? (
                        <button className="link" type="button" onClick={() => onView(comment)}>
                          View in diff
                        </button>
                      ) : (
                        <span>Outside the current diff</span>
                      )}
                    </footer>
                  </CommentCard>
                ),
              )}
            </section>
          ))}
      </div>
      {toolbar}
    </>
  )
  return (
    <aside
      className="comments-panel inline"
      id="comments-panel"
      aria-labelledby="comments-title"
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) onClose()
      }}
    >
      {content}
    </aside>
  )
}
