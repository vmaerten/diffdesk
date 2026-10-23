import { useState } from 'react'
import Icon from './Icon.tsx'
import ScopeControls from './ScopeControls.tsx'
import {
  commitLabel,
  RevisionSelector,
  togglePicker,
  type RevisionProps,
} from './RevisionControls.tsx'
import type { SavedView } from './savedView.ts'

/** The review controls the desktop app shows in its title bar. */
export default function DesktopToolbar(
  props: RevisionProps & {
    ignoreWhitespace: boolean
    onToggleWhitespace: () => void
    diffStyle: SavedView['diffStyle']
    onDiffStyleChange: (style: SavedView['diffStyle']) => void
    commentCount: number
    commentsOpen: boolean
    onToggleComments: () => void
    copiedAll: boolean
    onCopyAll: () => void
  },
) {
  const {
    data,
    target,
    commit,
    committed,
    withUntracked,
    ignoreWhitespace,
    picking,
    onPickingChange,
    onToggleCommitted,
    onToggleUntracked,
    onToggleWhitespace,
    diffStyle,
    onDiffStyleChange,
    commentCount,
    commentsOpen,
    onToggleComments,
    copiedAll,
    onCopyAll,
  } = props
  const [optionsOpen, setOptionsOpen] = useState(false)
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
            onClick={() => togglePicker(onPickingChange, 'base')}
          >
            {data?.base.ref ?? '…'} <span className="caret">▾</span>
          </button>
          <RevisionSelector picker="base" {...props} />
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
            onClick={() => togglePicker(onPickingChange, 'target')}
          >
            {data?.target.ref ?? 'HEAD'} <span className="caret">▾</span>
          </button>
          <RevisionSelector picker="target" {...props} />
        </span>
        <span className="capsule-separator" aria-hidden="true" />
        <span className="base-anchor">
          <button
            type="button"
            className="capsule-commit"
            title="Show one commit (l)"
            aria-expanded={picking === 'commit'}
            disabled={!data}
            onClick={() => togglePicker(onPickingChange, 'commit')}
          >
            {commitLabel(data)} <span className="caret">▾</span>
          </button>
          <RevisionSelector picker="commit" {...props} />
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
          {copiedAll ? 'Copied' : 'Copy'} <span className="counter">{commentCount}</span>
        </button>
        <button
          type="button"
          className="titlebar-button comments-trigger"
          title="Comments (⌥⌘0)"
          aria-label="Comments"
          aria-pressed={commentsOpen}
          aria-controls="comments-panel"
          disabled={!data}
          onClick={onToggleComments}
        >
          <Icon name="comment" />
        </button>
      </div>
    </>
  )
}
