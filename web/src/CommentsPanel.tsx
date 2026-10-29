import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { ServedComment } from '../../src/types.ts'
import type { SaveState } from './commentPersistence.ts'
import CommentCard, { commentLabel } from './CommentCard.tsx'
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
  onResolve,
  onRetry,
  composing,
  onCompose,
  onCreate,
  tabs,
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
  onResolve: (id: string) => void
  onRetry: (comment: ServedComment) => void
  /** The file a new comment is being written on; '' for the whole review. */
  composing: string | null
  onCompose: (path: string | null) => void
  /** A new comment on a whole file, or on the whole review for ''. */
  onCreate: (path: string, body: string) => void
  /** Comments and Symbol, in place of the title, while code intelligence shows both. */
  tabs?: ReactNode
}) {
  const [editing, setEditing] = useState<string | null>(savedEditor?.current.editing ?? null)
  const [draft, setDraft] = useState(savedEditor?.current.draft ?? '')
  useEffect(() => {
    if (savedEditor) savedEditor.current = { editing, draft }
  }, [savedEditor, editing, draft])
  const [newDraft, setNewDraft] = useState('')
  const groups = useMemo(() => {
    const paths = new Set(comments.map((comment) => comment.path))
    if (composing !== null) paths.add(composing)
    // The review first, then files in the tree's order, as the panel reads.
    const order = treeOrder([...paths].filter(Boolean))
    const rank = (path: string) => (path ? order.get(path)! : -1)
    const result = new Map<string, ServedComment[]>(
      [...paths].toSorted((a, b) => rank(a) - rank(b)).map((path) => [path, []]),
    )
    for (const comment of comments.toSorted(
      (a, b) => a.start - b.start || a.createdAt.localeCompare(b.createdAt),
    ))
      result.get(comment.path)!.push(comment)
    return [...result]
  }, [comments, composing])
  const create = () => {
    if (composing === null || !newDraft.trim()) return
    onCreate(composing, newDraft.trim())
    setNewDraft('')
  }
  const cancelCreate = () => {
    setNewDraft('')
    onCompose(null)
  }
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
        {copied === 'all' ? 'Copied' : 'Copy all'}
        <kbd>⇧⌘C</kbd>
      </button>
    </div>
  )
  const content = (
    <>
      <div className="comments-panel-head">
        {tabs ?? (
          <h2 id="comments-title">
            <Icon name="comment" /> Comments <span className="counter">{comments.length}</span>
          </h2>
        )}
        <button
          className="icon-button"
          type="button"
          aria-label="Comment on the review"
          title="Comment on the whole review"
          onClick={() => onCompose('')}
        >
          <Icon name="plus" />
        </button>
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
              comment. A file's header comments on the whole file, and + above on the whole review.
            </p>
          </div>
        )}
        {open &&
          groups.map(([path, group]) => (
            <section className="comment-file" key={path} aria-label={path || 'Review'}>
              <h3>
                <Icon name={path ? 'file' : 'comment'} />
                <span>{path || 'Review'}</span>
                <span className="counter">{group.length}</span>
              </h3>
              {composing === path && (
                <form
                  className="panel-editor"
                  onSubmit={(event) => {
                    event.preventDefault()
                    create()
                  }}
                >
                  <label>
                    {path ? 'Comment on the whole file' : 'Comment on the whole review'}
                    <textarea
                      autoFocus
                      rows={4}
                      value={newDraft}
                      onChange={(event) => setNewDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                          event.preventDefault()
                          create()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          cancelCreate()
                        }
                      }}
                    />
                  </label>
                  <footer>
                    <button type="button" className="button" onClick={cancelCreate}>
                      Cancel
                    </button>
                    <button type="submit" className="button primary" disabled={!newDraft.trim()}>
                      Comment
                    </button>
                  </footer>
                </form>
              )}
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
                      Edit comment · {commentLabel(comment)}
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
                    onResolve={onResolve}
                    onRetry={onRetry}
                  >
                    {comment.path && (
                      <footer className="comment-navigation">
                        {canView(comment) ? (
                          <button className="link" type="button" onClick={() => onView(comment)}>
                            View in diff
                          </button>
                        ) : (
                          <span>Outside the current diff</span>
                        )}
                      </footer>
                    )}
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
      aria-labelledby={tabs ? undefined : 'comments-title'}
      aria-label={tabs ? 'Comments' : undefined}
      hidden={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) onClose()
      }}
    >
      {content}
    </aside>
  )
}
