import Icon from './Icon.tsx'
import { GO_POC } from './capabilities.ts'
import type { SavedView } from './savedView.ts'

export default function ReviewTools({
  filesOpen,
  onToggleFiles,
  fileCount,
  viewedCount,
  ignoreWhitespace,
  onToggleWhitespace,
  diffStyle,
  onDiffStyleChange,
  loaded,
  commentCount,
  commentsOpen,
  onOpenComments,
  copiedAll,
  onCopyAll,
}: {
  filesOpen: boolean
  onToggleFiles: () => void
  fileCount: number
  viewedCount: number
  ignoreWhitespace: boolean
  onToggleWhitespace: () => void
  diffStyle: SavedView['diffStyle']
  onDiffStyleChange: (style: SavedView['diffStyle']) => void
  loaded: boolean
  commentCount: number
  commentsOpen: boolean
  onOpenComments: () => void
  copiedAll: boolean
  onCopyAll: () => void
}) {
  return (
    <div className="review-tools">
      <div className="review-tools-title">
        <button
          className="button files-toggle"
          type="button"
          aria-expanded={filesOpen}
          aria-controls="changed-files"
          onClick={onToggleFiles}
        >
          <Icon name="file" />
          Files
        </button>
        <strong>Files changed</strong>
        <span className="counter">{fileCount}</span>
        {viewedCount > 0 && (
          <span className="review-progress">
            {viewedCount}/{fileCount} viewed
          </span>
        )}
      </div>
      <div className="review-tools-actions">
        {!GO_POC && (
          <label className="whitespace-toggle">
            <input type="checkbox" checked={ignoreWhitespace} onChange={onToggleWhitespace} />
            Ignore whitespace
          </label>
        )}
        <div className="toggle view-toggle" aria-label="Diff layout">
          <button
            type="button"
            aria-pressed={diffStyle === 'unified'}
            onClick={() => onDiffStyleChange('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            aria-pressed={diffStyle === 'split'}
            onClick={() => onDiffStyleChange('split')}
          >
            Split
          </button>
        </div>

        <button
          type="button"
          className="button comments-trigger"
          disabled={!loaded}
          aria-haspopup="dialog"
          aria-expanded={commentsOpen}
          aria-controls="comments-panel"
          onClick={onOpenComments}
        >
          <Icon name="comment" />
          Comments <span className="counter">{commentCount}</span>
        </button>
        <button
          type="button"
          className="button primary copy-all"
          disabled={commentCount === 0}
          onClick={onCopyAll}
        >
          <Icon name="copy" />
          {copiedAll ? 'Copied' : 'Copy all'}
        </button>
      </div>
    </div>
  )
}
