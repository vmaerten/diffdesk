import { useState, type Dispatch, type SetStateAction } from 'react'
import Icon from './Icon.tsx'
import RefSelector from './RefSelector.tsx'
import CommitSelector from './CommitSelector.tsx'
import ScopeControls from './ScopeControls.tsx'
import type { Picker } from './RevisionControls.tsx'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'
import type { SavedView } from './savedView.ts'

/** The review controls the desktop app shows in its title bar. */
export default function DesktopToolbar({
  repoId,
  data,
  query,
  target,
  commit,
  committed,
  withUntracked,
  ignoreWhitespace,
  picking,
  onPickingChange,
  onPickBase,
  onPickTarget,
  onPickCommit,
  onToggleCommitted,
  onToggleUntracked,
  onToggleWhitespace,
  diffStyle,
  onDiffStyleChange,
  commentCount,
  commentsOpen,
  onOpenComments,
  copiedAll,
  onCopyAll,
}: {
  repoId: string | null
  data: LoadedReviewDiff | null
  query: string
  target: string | null
  commit: string | null
  committed: boolean
  withUntracked: boolean
  ignoreWhitespace: boolean
  picking: Picker | null
  onPickingChange: Dispatch<SetStateAction<Picker | null>>
  onPickBase: (base: string | null) => void
  onPickTarget: (ref: string | null) => void
  onPickCommit: (sha: string | null) => void
  onToggleCommitted: () => void
  onToggleUntracked: () => void
  onToggleWhitespace: () => void
  diffStyle: SavedView['diffStyle']
  onDiffStyleChange: (style: SavedView['diffStyle']) => void
  commentCount: number
  commentsOpen: boolean
  onOpenComments: () => void
  copiedAll: boolean
  onCopyAll: () => void
}) {
  const [optionsOpen, setOptionsOpen] = useState(false)
  const toggle = (picker: Picker) =>
    onPickingChange((current) => (current === picker ? null : picker))
  return (
    <>
      <div className="compare-capsule" role="group" aria-label="Comparison">
        <span className="base-anchor">
          <button
            type="button"
            className="capsule-ref"
            title="Change the base (b)"
            aria-label={`Base: ${data?.base.ref ?? 'loading'}`}
            aria-expanded={picking === 'base'}
            disabled={!data}
            onClick={() => toggle('base')}
          >
            {data?.base.ref ?? '…'} <span className="caret">▾</span>
          </button>
          {picking === 'base' && data && (
            <RefSelector
              repoId={repoId}
              current={data.base.ref}
              source={data.base.source}
              onPick={onPickBase}
              onClose={() => onPickingChange(null)}
            />
          )}
        </span>
        <span className="capsule-arrow" aria-hidden="true">
          →
        </span>
        <span className="base-anchor">
          <button
            type="button"
            className="capsule-ref"
            title="Review another revision (t)"
            aria-label={`Target: ${data?.target.ref ?? 'HEAD'}`}
            aria-expanded={picking === 'target'}
            disabled={!data}
            onClick={() => toggle('target')}
          >
            {data?.target.ref ?? 'HEAD'} <span className="caret">▾</span>
          </button>
          {picking === 'target' && data && (
            <RefSelector
              repoId={repoId}
              current={data.target.ref}
              source={data.target.workingTree ? 'working tree' : 'ref'}
              extra={{
                value: '__working_tree__ this checkout working tree',
                label: 'This checkout (working tree)',
                hint: 'uncommitted work included',
                pick: null,
              }}
              onPick={onPickTarget}
              onClose={() => onPickingChange(null)}
            />
          )}
        </span>
        <span className="capsule-separator" aria-hidden="true" />
        <span className="base-anchor">
          <button
            type="button"
            className="capsule-commit"
            title="Show one commit (l)"
            aria-expanded={picking === 'commit'}
            disabled={!data}
            onClick={() => toggle('commit')}
          >
            {data?.commit ? `${data.commit.short} ${data.commit.subject}` : 'All commits'}{' '}
            <span className="caret">▾</span>
          </button>
          {picking === 'commit' && data && (
            <CommitSelector
              repoId={repoId}
              query={query}
              current={data.commit}
              onPick={onPickCommit}
              onClose={() => onPickingChange(null)}
            />
          )}
        </span>
      </div>

      <div className="titlebar-actions">
        <div className="segmented" role="group" aria-label="Diff layout">
          <button
            type="button"
            title="Unified (⌘1)"
            aria-pressed={diffStyle === 'unified'}
            onClick={() => onDiffStyleChange('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            title="Split (⌘2)"
            aria-pressed={diffStyle === 'split'}
            onClick={() => onDiffStyleChange('split')}
          >
            Split
          </button>
        </div>
        <span className="base-anchor">
          <button
            type="button"
            className="titlebar-button titlebar-text"
            title="Diff options"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((open) => !open)}
          >
            Options <span className="caret">▾</span>
          </button>
          {optionsOpen && (
            <>
              <div className="picker-backdrop" onMouseDown={() => setOptionsOpen(false)} />
              <div className="options-popover" role="group" aria-label="Diff options">
                <ScopeControls
                  data={data}
                  target={target}
                  commit={commit}
                  committed={committed}
                  withUntracked={withUntracked}
                  onToggleCommitted={onToggleCommitted}
                  onToggleUntracked={onToggleUntracked}
                />
                <label className="scope-check" title="Hide changes that only touch whitespace">
                  <input type="checkbox" checked={ignoreWhitespace} onChange={onToggleWhitespace} />
                  <span>Ignore whitespace</span>
                </label>
              </div>
            </>
          )}
        </span>
        <button
          type="button"
          className="titlebar-button titlebar-text copy-all"
          title="Copy all comments as Markdown (⇧⌘C)"
          disabled={commentCount === 0}
          onClick={onCopyAll}
        >
          {copiedAll ? 'Copied' : 'Copy'} <span className="titlebar-count">{commentCount}</span>
        </button>
        <button
          type="button"
          className="titlebar-button comments-trigger"
          title="Comments (⌥⌘0)"
          aria-label="Comments"
          aria-haspopup="dialog"
          aria-expanded={commentsOpen}
          aria-controls="comments-panel"
          disabled={!data}
          onClick={onOpenComments}
        >
          <Icon name="comment" />
        </button>
      </div>
    </>
  )
}
