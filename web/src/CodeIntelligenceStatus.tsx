import DesktopSheet from './DesktopSheet.tsx'
import {
  homeRelative,
  languageSupportsPath,
  stateLabel,
  useLanguageStatus,
} from './codeIntelligence.ts'
import { sendCommand } from './commands.ts'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'

/** A fresh diagnostic of the checkout, available even when code intelligence is off. */
export default function CodeIntelligenceStatus({
  repoId,
  data,
  activePath,
  enabled,
  settingsApplied,
  symbolPanel,
  onClose,
}: {
  repoId: string | null
  data: LoadedReviewDiff | null
  activePath: string | null
  enabled: boolean
  settingsApplied: boolean
  symbolPanel: boolean
  onClose: () => void
}) {
  const [status, refresh, error] = useLanguageStatus(repoId, 0, data?.comparison.after)
  const language = status?.languages.find(
    (entry) => activePath && languageSupportsPath(entry, activePath),
  )
  const reasons: string[] = []
  if (!enabled)
    reasons.push('Code intelligence is disabled. Enable “Use language servers” in Settings.')
  else if (!settingsApplied || (status && !status.enabled))
    reasons.push('Code intelligence settings have not been applied to the review server yet.')
  if (!data) reasons.push('The review has not loaded yet.')
  if (error) reasons.push('Code intelligence status could not be checked.')
  if (activePath && status) {
    if (!language) reasons.push('No language server supports the active file.')
    else if (language.state === 'off') reasons.push(`${language.label} is disabled in Settings.`)
    else if (language.state === 'missing')
      reasons.push(`${language.label} has no installed language server.`)
    else if (language.state === 'failed')
      reasons.push(`${language.label}’s language server failed. See its error below.`)
    else if (language.state === 'starting' || language.state === 'indexing')
      reasons.push(`${language.label}’s language server is ${stateLabel(language).toLowerCase()}`)
  }
  return (
    <DesktopSheet open title="IntelliSense Status" className="intelligence-sheet" onClose={onClose}>
      <dl className="intelligence-comparison">
        <div>
          <dt>Checkout</dt>
          <dd>{data?.head.branch ?? 'Detached HEAD'}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{data?.target.ref ?? 'Loading…'}</dd>
        </div>
        <div>
          <dt>Working tree</dt>
          <dd>{data ? (data.target.workingTree ? 'Included' : 'Excluded') : 'Loading…'}</dd>
        </div>
        <div>
          <dt>Active file</dt>
          <dd>{activePath ?? 'None'}</dd>
        </div>
        <div>
          <dt>Analyzed version</dt>
          <dd>
            {data?.comparison.after
              ? `Isolated revision ${data.comparison.after.slice(0, 12)}`
              : 'Working tree'}
          </dd>
        </div>
      </dl>
      <div className="intelligence-summary" role="status">
        {reasons.length > 0 ? (
          <ul>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : status ? (
          <p>
            Code intelligence is enabled for this comparison.{' '}
            {language?.state === 'idle' ? 'The server starts on the first symbol lookup.' : ''}
          </p>
        ) : (
          <p>Checking language servers…</p>
        )}
      </div>
      {error && <p role="alert">Could not check language servers: {error}</p>}
      {data?.comparison.after && (
        <p>
          Diffdesk analyzes an isolated copy of the displayed revision. Dependencies are not
          installed automatically; some external imports may be unresolved.
          {status?.workspace?.path && (
            <>
              {' '}
              Copy: <code>{homeRelative(status.workspace.path)}</code>.
            </>
          )}
        </p>
      )}
      <p>
        Hold ⌘ over an identifier on the new side of the diff for symbol info; ⌘-click opens its
        definition. Deleted lines cannot be queried. If the file changed on disk, refresh the review
        with <kbd>r</kbd>.
      </p>
      <p>
        {symbolPanel
          ? 'Choose References in the symbol card to see its uses.'
          : 'Enable “Symbol panel” in Settings to show the References action.'}
      </p>
      <h3>Language servers</h3>
      {!status && !error && <p>Checking language servers…</p>}
      {status && (
        <dl className="intelligence-servers">
          {status.languages.map((entry) => (
            <div key={entry.id} data-language={entry.id} data-state={entry.state}>
              <dt>
                {entry.label}
                {language?.id === entry.id ? ' · active file' : ''}
                <span>{stateLabel(entry)}</span>
              </dt>
              <dd>
                {entry.server && (
                  <p>
                    {entry.server.name}
                    {entry.version ? ` ${entry.version}` : ''} · {homeRelative(entry.server.path)}
                  </p>
                )}
                {entry.state === 'idle' && <p>Starts on the first symbol lookup.</p>}
                {entry.progress && (
                  <p>
                    {entry.progress.title} {entry.progress.message}
                    {entry.progress.percentage !== undefined
                      ? ` (${entry.progress.percentage}%)`
                      : ''}
                  </p>
                )}
                {entry.error && <pre>{entry.error}</pre>}
                {entry.install && (
                  <p>
                    Install: <code>{entry.install}</code>
                  </p>
                )}
                {entry.state === 'off' && <p>Enable this language in Settings.</p>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <div className="intelligence-actions">
        <button type="button" className="button" onClick={refresh}>
          Refresh status
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            onClose()
            sendCommand('settings')
          }}
        >
          Open Settings…
        </button>
      </div>
    </DesktopSheet>
  )
}
