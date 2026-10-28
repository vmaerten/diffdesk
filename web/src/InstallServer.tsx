import { useState } from 'react'
import { installLanguageServer } from './codeIntelligence.ts'
import type { LanguageStatus } from '../../src/types.ts'

const COPY = 'copy'

/** What a missing server's install says: running, failed, or what it would run. */
export function installNote(language: LanguageStatus): string {
  if (language.installing) return `Installing with ${language.installing}…`
  if (language.installError) return `${language.installError.manager} couldn’t install it`
  return 'Not installed'
}

/**
 * Install, Try Again or Copy for a language without a server. Go runs the
 * command; the page only names the language and one of the managers it offered.
 */
export default function InstallServer({
  repoId,
  language,
  onStarted,
}: {
  repoId: string | null
  language: LanguageStatus
  onStarted: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  if (language.server || language.state === 'off') return null
  if (language.installing) return <span className="install-spinner" aria-hidden="true" />
  const copy = (command: string) =>
    navigator.clipboard.writeText(command).catch((cause) => setError(String(cause)))
  const install = (manager: string) => {
    if (!repoId) return
    setError(null)
    installLanguageServer(repoId, language.id, manager).then(onStarted, (cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }
  const installs = language.installs ?? []
  const failed = language.installError
  const first = installs.find((option) => option.manager === failed?.manager) ?? installs[0]
  if (!first)
    return language.install ? (
      <button type="button" className="button" onClick={() => copy(language.install!)}>
        Copy Command
      </button>
    ) : null
  return (
    <span className="install-server">
      <button type="button" className="button primary" onClick={() => install(first.manager)}>
        {failed ? 'Try Again' : `Install with ${first.manager}`}
      </button>
      <span className="install-more">
        <select
          className="button primary"
          aria-label={`Other ways to install a ${language.label} server`}
          value=""
          onChange={(event) => {
            const choice = event.target.value
            if (choice === COPY) copy(first.command)
            else if (choice) install(choice)
          }}
        >
          <option value="" disabled>
            Install with
          </option>
          {installs.map((option) => (
            <option key={option.manager} value={option.manager}>
              {option.manager} · {option.command}
            </option>
          ))}
          <option value={COPY}>Copy {first.manager} Command</option>
        </select>
      </span>
      {error && (
        <span className="install-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
