import type { Dispatch, SetStateAction } from 'react'
import RefSelector from './RefSelector.tsx'
import CommitSelector from './CommitSelector.tsx'
import { GO_POC } from './capabilities.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

export type Picker = 'base' | 'target' | 'commit'

export default function RevisionControls({
  repoId,
  data,
  query,
  target,
  commit,
  committed,
  withUntracked,
  baseSource,
  picking,
  onPickingChange,
  onPickBase,
  onPickTarget,
  onPickCommit,
  onToggleCommitted,
  onToggleUntracked,
}: {
  repoId: string | null
  data: LoadedReviewDiff | null
  query: string
  target: string | null
  commit: string | null
  committed: boolean
  withUntracked: boolean
  baseSource: string | null
  picking: Picker | null
  onPickingChange: Dispatch<SetStateAction<Picker | null>>
  onPickBase: (base: string | null) => void
  onPickTarget: (ref: string | null) => void
  onPickCommit: (sha: string | null) => void
  onToggleCommitted: () => void
  onToggleUntracked: () => void
}) {
  return (
    <div className="revision">
      <div className="toolbar-group compare-group">
        <span className="toolbar-label">
          Compare {baseSource && <span className="source">· base {baseSource}</span>}
        </span>
        <div className="revision-flow">
          <span className="base-anchor">
            <span className="ref-role">Base</span>
            {GO_POC ? (
              <span className="ref base">{data?.base?.ref ?? '…'}</span>
            ) : (
              <button
                type="button"
                className="ref base"
                onClick={() => onPickingChange((current) => (current === 'base' ? null : 'base'))}
                title="Change the base (b)"
                aria-label={`Base: ${data?.base?.ref ?? 'loading'}`}
                aria-expanded={picking === 'base'}
                disabled={!data}
              >
                {data?.base?.ref ?? '…'} <span className="caret">▾</span>
              </button>
            )}

            {!GO_POC && picking === 'base' && data && (
              <RefSelector
                repoId={repoId}
                current={data.base.ref}
                source={data.base.source}
                onPick={onPickBase}
                onClose={() => onPickingChange(null)}
              />
            )}
          </span>

          <span className="arrow" aria-hidden="true">
            →
          </span>

          <span className="base-anchor">
            <span className="ref-role">Target</span>
            {GO_POC ? (
              <span className="ref target">{data?.target?.ref ?? 'HEAD'}</span>
            ) : (
              <button
                type="button"
                className="ref target"
                onClick={() =>
                  onPickingChange((current) => (current === 'target' ? null : 'target'))
                }
                title="Review another revision (t)"
                aria-label={`Target: ${data?.target?.ref ?? 'HEAD'}`}
                aria-expanded={picking === 'target'}
                disabled={!data}
              >
                {data?.target?.ref ?? 'HEAD'} <span className="caret">▾</span>
              </button>
            )}

            {!GO_POC && picking === 'target' && data && (
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
        </div>
      </div>

      {/* Beside the chain, not a third link in it: `main → feature → abc1234`
          reads as "from main up to that commit", which is the cumulative
          diff. This one is the commit's own. */}
      {!GO_POC && (
        <div className="toolbar-group commit-group">
          <span className="toolbar-label">Commit</span>
          <span className="base-anchor">
            <button
              type="button"
              className="ref commit"
              onClick={() => onPickingChange((current) => (current === 'commit' ? null : 'commit'))}
              title="Show one commit (l)"
              aria-expanded={picking === 'commit'}
              disabled={!data}
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
      )}

      <div className="toolbar-group scope-group">
        <span className="toolbar-label">Include</span>
        <div className="scope-controls">
          {/* A state, not a command: it changes what the diff contains. */}
          <label className="scope-check" title="Include the uncommitted work, staged or not">
            <input
              type="checkbox"
              className="worktree"
              // The server's answer, not this button's own state: in a commit or
              // a ref view the working tree is out whatever the flag says, and a
              // checked box there would claim the opposite.
              checked={data?.target.workingTree ?? !committed}
              onChange={onToggleCommitted}
              // Already out of the diff there, and both cases say so themselves.
              disabled={!data || target !== null || commit !== null}
            />
            <span>Working tree</span>
          </label>

          {!GO_POC && (
            <label className="scope-check" title="Include the files git does not track yet">
              <input
                type="checkbox"
                className="untracked"
                checked={data?.untrackedIncluded ?? withUntracked}
                onChange={onToggleUntracked}
                // One condition for the four cases that leave nothing to include —
                // a ref, a commit, the working tree out, a checkout with no stray
                // file — because `buildPatch` empties the list in all of them.
                disabled={!data || data.untracked.length === 0}
              />
              <span>
                {/* The count is the whole reason the default is off: 2 changed
                  files against 446 untracked ones is what it protects against,
                  and it reads both ways — what is being hidden, or what was
                  taken in. */}
                Untracked
                {data && data.untracked.length > 0 ? ` (${data.untracked.length})` : ''}
              </span>
            </label>
          )}
        </div>
      </div>

      {data?.commit ? (
        <span className="source revision-note">one commit — the base is not compared</span>
      ) : (
        data &&
        !data.target.workingTree && (
          <span className="source revision-note">
            {target ? 'reviewing a ref, working tree excluded' : 'working tree excluded'}
          </span>
        )
      )}
    </div>
  )
}
