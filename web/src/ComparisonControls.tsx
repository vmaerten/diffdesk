import type { Dispatch, SetStateAction } from 'react'
import RefSelector from './RefSelector.tsx'
import CommitSelector from './CommitSelector.tsx'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

export type Picker = 'base' | 'target' | 'commit' | 'stack'

/** Why the diff is not simply the base against the working tree, when it is not. */
export function comparisonNote(
  data: LoadedReviewDiff | null,
  target: string | null,
): string | null {
  if (data?.commit) return 'one commit — the base is not compared'
  if (data && !data.target.workingTree)
    return target ? 'reviewing a ref, working tree excluded' : 'working tree excluded'
  return null
}

const WORKING_TREE = '__working_tree__ this checkout working tree'

/** The comparison state and actions the title bar renders. */
export interface ComparisonProps {
  repoId: string | null
  data: LoadedReviewDiff | null
  query: string
  target: string | null
  commit: string | null
  committed: boolean
  withUntracked: boolean
  picking: Picker | null
  onPickingChange: Dispatch<SetStateAction<Picker | null>>
  onPickBase: (base: string | null) => void
  onPickTarget: (ref: string | null) => void
  onPickCommit: (sha: string | null) => void
  onToggleCommitted: () => void
  onToggleUntracked: () => void
}

export const togglePicker = (set: ComparisonProps['onPickingChange'], picker: Picker) =>
  set((current) => (current === picker ? null : picker))

export const commitLabel = (data: LoadedReviewDiff | null) =>
  data?.commit ? `${data.commit.short} ${data.commit.subject}` : 'All commits'

/** The ref or commit list a revision button opens, while it is the open one. */
export function ComparisonSelector({
  picker,
  repoId,
  data,
  query,
  picking,
  onPickingChange,
  onPickBase,
  onPickTarget,
  onPickCommit,
}: ComparisonProps & { picker: Exclude<Picker, 'stack'> }) {
  if (picking !== picker || !data) return null
  const close = () => onPickingChange(null)
  if (picker === 'commit')
    return (
      <CommitSelector
        repoId={repoId}
        query={query}
        current={data.commit}
        onPick={onPickCommit}
        onClose={close}
      />
    )
  if (picker === 'base')
    return (
      <RefSelector
        repoId={repoId}
        kind="base"
        current={data.base.ref}
        source={data.base.source}
        extra={
          data.base.source === 'override'
            ? {
                value: '__automatic__ automatic base',
                label: 'Automatic base',
                hint: 'from the stack, the branch point or the trunk',
                pick: null,
              }
            : undefined
        }
        onPick={onPickBase}
        onClose={close}
      />
    )
  return (
    <RefSelector
      repoId={repoId}
      kind="target"
      current={data.target.ref}
      selected={data.target.workingTree ? WORKING_TREE : data.target.ref}
      source={data.target.workingTree ? 'working tree' : 'ref'}
      extra={{
        value: WORKING_TREE,
        label: 'This checkout (working tree)',
        hint: 'uncommitted work included',
        pick: null,
      }}
      onPick={onPickTarget}
      onClose={close}
    />
  )
}
