import type { Dispatch, SetStateAction } from 'react'
import RefSelector from './RefSelector.tsx'
import CommitSelector from './CommitSelector.tsx'
import ScopeControls from './ScopeControls.tsx'
import { GO_POC } from './capabilities.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

export type Picker = 'base' | 'target' | 'commit'

/** Why the diff is not simply the base against the working tree, when it is not. */
export function revisionNote(data: LoadedReviewDiff | null, target: string | null): string | null {
  if (data?.commit) return 'one commit — the base is not compared'
  if (data && !data.target.workingTree)
    return target ? 'reviewing a ref, working tree excluded' : 'working tree excluded'
  return null
}

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
  const note = revisionNote(data, target)
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
          <ScopeControls
            data={data}
            target={target}
            commit={commit}
            committed={committed}
            withUntracked={withUntracked}
            onToggleCommitted={onToggleCommitted}
            onToggleUntracked={onToggleUntracked}
          />
        </div>
      </div>

      {note && <span className="source revision-note">{note}</span>}
    </div>
  )
}
