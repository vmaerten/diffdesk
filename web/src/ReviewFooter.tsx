import type { LoadedReviewDiff } from './useReviewDiff.tsx'
import type { LanguageStatus } from '../../src/types.ts'
import { stateLabel } from './codeIntelligence.ts'

/** What a server's name needs beside it in the status bar; nothing once it runs. */
function stateNote(language: LanguageStatus): string {
  return language.state === 'ready' || language.state === 'idle'
    ? ''
    : ` ${stateLabel(language).toLowerCase()}`
}
import PullRequestPill from './PullRequestPill.tsx'
import type { PullRequest } from '../../src/types.ts'

/** The desktop status bar: what the diff covers and what comes next. */
export default function ReviewFooter({
  data,
  baseSource,
  note,
  nextPath,
  onNext,
  languages,
  pullRequest,
}: {
  data: LoadedReviewDiff | null
  baseSource: string | null
  note: string | null
  nextPath: string | null
  onNext: () => void
  /** The diff's languages and their servers; null while code intelligence is off. */
  languages: LanguageStatus[] | null
  /** Shown here when the settings put it in the status bar. */
  pullRequest: PullRequest | null
}) {
  const untracked = data?.untracked.length ?? 0
  const status = [
    baseSource && `base ${baseSource}`,
    data && (note ?? 'working tree included'),
    untracked > 0 && `${untracked} untracked ${data?.untrackedIncluded ? 'included' : 'hidden'}`,
  ].filter(Boolean)
  return (
    <footer className="review-footer">
      {pullRequest && data && (
        <PullRequestPill
          pr={pullRequest}
          workingTree={data.target.workingTree}
          place="status-bar"
        />
      )}
      {status.map((item) => (
        <span key={item as string}>{item}</span>
      ))}
      {languages && data && !data.target.workingTree && (
        <span className="code-intelligence-status">Code intelligence: working tree only</span>
      )}
      {languages && data?.target.workingTree && languages.length > 0 && (
        <span className="code-intelligence-status">
          {languages.map((language) => (
            <span
              key={language.id}
              className="language-state"
              data-state={language.state}
              title={language.error ?? language.install ?? stateLabel(language)}
            >
              <i aria-hidden="true" />
              {language.server?.name ?? language.label}
              {stateNote(language)}
            </span>
          ))}
          <span className="beta-badge">Beta</span>
        </span>
      )}
      {nextPath && (
        <button type="button" className="footer-next" title="Next file (j)" onClick={onNext}>
          Next <b>{nextPath}</b> <kbd>j</kbd>
        </button>
      )}
    </footer>
  )
}
