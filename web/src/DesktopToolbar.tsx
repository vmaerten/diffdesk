import { useState } from 'react'
import Icon from './Icon.tsx'
import ScopeControls from './ScopeControls.tsx'
import StackPicker from './StackPicker.tsx'
import PullRequestPill from './PullRequestPill.tsx'
import type { PullRequest } from '../../src/types.ts'
import {
  commitLabel,
  ComparisonSelector,
  togglePicker,
  type ComparisonProps,
} from './ComparisonControls.tsx'
import type { SavedView } from './savedView.ts'

/** The review controls the desktop app shows in its title bar. */
export default function DesktopToolbar(
  props: ComparisonProps & {
    ignoreWhitespace: boolean
    onToggleWhitespace: () => void
    diffStyle: SavedView['diffStyle']
    onDiffStyleChange: (style: SavedView['diffStyle']) => void
    commentCount: number
    commentsOpen: boolean
    onToggleComments: () => void
    copiedAll: boolean
    onCopyAll: () => void
    /** Shown here when the settings put it in the title bar. */
    pullRequest: PullRequest | null
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
    onPickTarget,
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
    pullRequest,
  } = props
  const [optionsOpen, setOptionsOpen] = useState(false)
  const stack = data?.base.stack
  return (
    <>
      <div className="compare-capsule" role="group" aria-label="Comparison">
        {stack && (
          <>
            <span className="base-anchor">
              <button
                type="button"
                className="capsule-stack"
                title="Choose a stack layer (s)"
                aria-label={`Stack: layer ${stack.current + 1} of ${stack.layers.length}`}
                aria-expanded={picking === 'stack'}
                onClick={() => togglePicker(onPickingChange, 'stack')}
              >
                <Icon name="stack" />
                {stack.current + 1}/{stack.layers.length} <span className="caret">▾</span>
              </button>
              {picking === 'stack' && (
                <StackPicker
                  stack={stack}
                  headBranch={data?.head.branch}
                  onPick={onPickTarget}
                  onClose={() => onPickingChange(null)}
                />
              )}
            </span>
            <span className="capsule-separator" aria-hidden="true" />
          </>
        )}
        {/* Text, not a button: clicking here meant to change the reviewed
            branch, and changed the base. b and Go → Choose Base… still do. */}
        <span className="base-anchor">
          <span className="capsule-base" title="Compared against this base; b changes it">
            {data?.base.ref ?? '…'}
          </span>
          <ComparisonSelector picker="base" {...props} />
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
          <ComparisonSelector picker="target" {...props} />
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
          <ComparisonSelector picker="commit" {...props} />
        </span>
      </div>

      <div className="titlebar-actions">
        {pullRequest && data && (
          <PullRequestPill
            pr={pullRequest}
            workingTree={data.target.workingTree}
            place="title-bar"
          />
        )}
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
          title="Copy all comments for an agent (⇧⌘C)"
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
