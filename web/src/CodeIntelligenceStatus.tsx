import { useState } from 'react'
import DesktopSheet from './DesktopSheet.tsx'
import {
  homeRelative,
  languageSupportsPath,
  stateLabel,
  useLanguageStatus,
} from './codeIntelligence.ts'
import { sendCommand } from './commands.ts'
import { readSettings } from './desktopSettings.ts'
import InstallServer, { installNote } from './InstallServer.tsx'
import type { LoadedReviewDiff } from './useReviewDiff.tsx'
import type { LanguageStatus } from '../../src/types.ts'

/** What keeps every language from answering, with the one action that fixes it. */
interface Blocker {
  title: string
  detail: string
  action?: { label: string; run: () => void }
}

/** The row's second column: the server, or what to do without one. */
function serverCell(language: LanguageStatus) {
  if (language.server)
    return (
      <>
        <b>{language.server.name}</b>
        {language.version ? ` ${language.version}` : ''}
        {language.server.origin === 'checkout' ? ' · from this checkout' : ''}
      </>
    )
  if (language.state === 'off') return 'Off in Settings'
  if (language.installs?.length || language.installing || language.installError)
    return installNote(language)
  if (language.install) return <code>{language.install}</code>
  return 'No server found'
}

function stateCell(language: LanguageStatus): string {
  if (language.state === 'idle') return 'Starts on ⌘-hover'
  if (language.state === 'off' || language.state === 'missing') return ''
  return stateLabel(language)
}

/** A fresh diagnostic of the checkout, available even when code intelligence is off. */
export default function CodeIntelligenceStatus({
  repoId,
  data,
  activePath,
  enabled,
  settingsApplied,
  onClose,
}: {
  repoId: string | null
  data: LoadedReviewDiff | null
  activePath: string | null
  enabled: boolean
  settingsApplied: boolean
  onClose: () => void
}) {
  const [status, refresh, error] = useLanguageStatus(repoId, 0, data?.comparison.after)
  const [turnOnError, setTurnOnError] = useState<string | null>(null)
  const api = window.go?.main.desktopApp
  // Go owns the settings and sends the change to every window, this review included.
  const turnOn = async () => {
    if (!api) return
    setTurnOnError(null)
    try {
      const settings = readSettings(await api.Settings())
      await api.SaveSettings(JSON.stringify({ ...settings, codeIntelligence: true }))
    } catch (cause) {
      setTurnOnError(String(cause))
    }
  }
  let blocker: Blocker | null = null
  if (!enabled)
    blocker = {
      title: 'IntelliSense is off',
      detail: turnOnError ?? 'No server runs until you turn it on.',
      action: api ? { label: 'Turn On', run: () => void turnOn() } : undefined,
    }
  else if (error)
    blocker = {
      title: 'Couldn’t check the language servers',
      detail: error,
      action: { label: 'Try Again', run: refresh },
    }
  else if (!settingsApplied || (status && !status.enabled))
    blocker = {
      title: 'Applying your settings…',
      detail: 'The review server hasn’t received them yet.',
      action: { label: 'Try Again', run: refresh },
    }
  else if (!data) blocker = { title: 'Loading the review…', detail: 'Servers show once it loads.' }
  const active = status?.languages.find(
    (entry) => activePath && languageSupportsPath(entry, activePath),
  )
  const copy = data?.comparison.after
  return (
    <DesktopSheet
      open
      title="IntelliSense"
      className="intelligence-sheet"
      onClose={onClose}
      actions={
        <>
          <span className="intelligence-hint">
            <kbd>⌘</kbd> hover for info · <kbd>⌘</kbd> click for definition
          </span>
          <button
            type="button"
            className="button"
            onClick={() => {
              onClose()
              sendCommand('settings')
            }}
          >
            Settings…
          </button>
        </>
      }
    >
      {data && (
        <p className="intelligence-context">
          {data.base.ref} → {data.target.ref}
          {copy ? (
            <>
              {' '}
              · revision copy <code>{copy.slice(0, 7)}</code>
            </>
          ) : (
            ' · working tree'
          )}
        </p>
      )}
      {blocker && (
        <div className="intelligence-blocker" role="status">
          <span>
            <b>{blocker.title}</b>
            {blocker.detail}
          </span>
          {blocker.action && (
            <button type="button" className="button primary" onClick={blocker.action.run}>
              {blocker.action.label}
            </button>
          )}
        </div>
      )}
      {status ? (
        <ul className="intelligence-servers" aria-label="Language servers">
          {status.languages.map((language) => (
            <li
              key={language.id}
              data-language={language.id}
              data-state={language.state}
              className={!enabled && language.state !== 'missing' ? 'muted' : undefined}
            >
              <i aria-hidden="true" />
              <span className="intelligence-language">
                {language.label}
                {active?.id === language.id && <small>Active file</small>}
              </span>
              <span className="intelligence-server">{serverCell(language)}</span>
              <span className="intelligence-state">
                {stateCell(language)}
                <InstallServer repoId={repoId} language={language} onStarted={refresh} />
              </span>
              {(language.error ?? language.installError?.log) && (
                <pre>{language.error ?? language.installError?.log}</pre>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !error && <p className="intelligence-checking">Checking language servers…</p>
      )}
      {data && (
        <details className="intelligence-details">
          <summary>Details</summary>
          <dl>
            <div>
              <dt>Checkout</dt>
              <dd>{data.head.branch ?? 'Detached HEAD'}</dd>
            </div>
            <div>
              <dt>Target</dt>
              <dd>{data.target.ref}</dd>
            </div>
            <div>
              <dt>Working tree</dt>
              <dd>{data.target.workingTree ? 'Included' : 'Excluded'}</dd>
            </div>
            <div>
              <dt>Active file</dt>
              <dd>{activePath ?? 'None'}</dd>
            </div>
            <div>
              <dt>Analyzed</dt>
              <dd>
                {copy ? `Isolated revision ${copy.slice(0, 12)}` : 'Working tree'}
                {status?.workspace?.path && (
                  <>
                    {' '}
                    in <code>{homeRelative(status.workspace.path)}</code>
                  </>
                )}
              </dd>
            </div>
          </dl>
          {copy && <p>Dependencies aren’t installed in the copy: some imports may not resolve.</p>}
        </details>
      )}
    </DesktopSheet>
  )
}
