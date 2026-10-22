import StackNav from './StackNav.tsx'
import type { StackChain } from '../../src/types.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

/** The desktop status bar: what the diff covers, the stack, and what comes next. */
export default function ReviewFooter({
  data,
  baseSource,
  note,
  stack,
  onPickTarget,
  nextPath,
  onNext,
}: {
  data: LoadedReviewDiff | null
  baseSource: string | null
  note: string | null
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
