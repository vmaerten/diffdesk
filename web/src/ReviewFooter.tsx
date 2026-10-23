import StackNav from './StackNav.tsx'
import type { StackChain, Totals } from '../../src/types.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

/** The desktop status bar: what the diff covers, where the review stands, what comes next. */
export default function ReviewFooter({
  data,
  baseSource,
  note,
  stats,
  viewedCount,
  stack,
  onPickTarget,
  nextPath,
  onNext,
}: {
  data: LoadedReviewDiff | null
  baseSource: string | null
  note: string | null
  stats: Totals
  viewedCount: number
  stack: StackChain | null
  onPickTarget: (ref: string | null) => void
  nextPath: string | null
  onNext: () => void
}) {
  const untracked = data?.untracked.length ?? 0
  const status = [
    baseSource && `base ${baseSource}`,
    data && (note ?? 'working tree included'),
    untracked > 0 && `${untracked} untracked ${data?.untrackedIncluded ? 'included' : 'hidden'}`,
  ].filter(Boolean)
  return (
    <footer className="review-footer">
      {status.map((item) => (
        <span key={item as string}>{item}</span>
      ))}
      {data && (
        <span className="footer-stats">
          {stats.files} files <span className="add">+{stats.additions}</span>{' '}
          <span className="del">−{stats.deletions}</span>
        </span>
      )}
      {viewedCount > 0 && (
        <span>
          {viewedCount}/{stats.files} viewed
        </span>
      )}
      {stack && (
        <StackNav stack={stack} headBranch={data?.head.branch} onPickTarget={onPickTarget} />
      )}
      {nextPath && (
        <button type="button" className="footer-next" title="Next file (j)" onClick={onNext}>
          Next <b>{nextPath}</b> <kbd>j</kbd>
        </button>
      )}
    </footer>
  )
}
