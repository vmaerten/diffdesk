import { GO_POC } from './capabilities.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

/** What the diff takes in beyond the commits: uncommitted work and untracked files. */
export default function ScopeControls({
  data,
  target,
  commit,
  committed,
  withUntracked,
  onToggleCommitted,
  onToggleUntracked,
}: {
  data: LoadedReviewDiff | null
  target: string | null
  commit: string | null
  committed: boolean
  withUntracked: boolean
  onToggleCommitted: () => void
  onToggleUntracked: () => void
}) {
  return (
    <>
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
    </>
  )
}
