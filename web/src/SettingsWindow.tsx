import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PatchDiff, useStableCallback } from '@pierre/diffs/react'
import { THEMES, themeById, type ThemeId } from './theme.ts'
import { activeTheme, useAppearance, type Appearance } from './appearance.ts'
import {
  CODE_FONTS,
  CODE_SIZE,
  codeVariables,
  DEFAULT_SETTINGS,
  isFontName,
  LANGUAGE_SERVERS,
  latestSaver,
  readSettings,
  type DesktopSettings,
  type LanguageId,
  type PullRequestPlace,
} from './desktopSettings.ts'
import {
  homeRelative,
  languageConfig,
  sendLanguageConfig,
  SERVER_CHOICE_LABELS,
  stateLabel,
  useLanguageStatus,
} from './codeIntelligence.ts'
import type { GitHubAccount, LanguageStatus } from '../../src/types.ts'
import desktopStyles from './desktop.css?inline'
import { copyDebugLogs, debugLog } from './debugLog.ts'
import { startDebugActions } from './debugActions.ts'

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const PULL_REQUEST_PLACES: { place: PullRequestPlace; label: string }[] = [
  { place: 'title-bar', label: 'Title bar' },
  { place: 'status-bar', label: 'Status bar' },
]

const TITLE_BARS = [
  { compact: false, label: 'Standard' },
  { compact: true, label: 'Compact' },
]

const PREVIEW = `diff --git a/open.go b/open.go
--- a/open.go
+++ b/open.go
@@ -12,3 +12,4 @@
 func open(repo string) error {
-	return run(repo, "HEAD", 1)
+	// Resolve the base once.
+	return run(repo, base(repo), 2)
 }
`

type Pane = 'appearance' | 'code' | 'window' | 'github' | 'intelligence'

const PANES: { id: Pane; label: string; icon: ReactNode }[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    id: 'code',
    label: 'Code',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M8.5 7 3.5 12l5 5M15.5 7l5 5-5 5" />
      </svg>
    ),
  },
  {
    id: 'window',
    label: 'Window',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="M3.5 9.5h17" />
      </svg>
    ),
  },
  {
    id: 'github',
    label: 'GitHub',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="6.5" cy="6" r="2.5" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="17.5" cy="18" r="2.5" />
        <path d="M6.5 8.5v7M17.5 15.5V10a3 3 0 0 0-3-3H11M13 4.5 10.5 7 13 9.5" />
      </svg>
    ),
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
      </svg>
    ),
  },
]

/** A missing family renders in its fallback, so its glyphs measure the same. */
function installed(font: string): boolean {
  if (font === 'SF Mono') return true
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return true
  const sample = 'mmmmmmmmmmlli0O{}=>'
  return ['monospace', 'serif', 'sans-serif'].some((fallback) => {
    context.font = `72px ${fallback}`
    const width = context.measureText(sample).width
    context.font = `72px "${font}", ${fallback}`
    return context.measureText(sample).width !== width
  })
}

/**
 * The Settings window, the only place that changes the settings: it saves each
 * change at once, and Go hands the saved document to every window.
 */
export default function SettingsWindow() {
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pane, setPane] = useState<Pane>('appearance')
  useAppearance(settings ?? DEFAULT_SETTINGS)
  useEffect(() => {
    window.go?.main.desktopApp
      .Settings()
      .then((raw) => setSettings(readSettings(raw)))
      .catch((cause) => {
        setError(String(cause))
        setSettings(DEFAULT_SETTINGS)
      })
  }, [])
  const save = useMemo(
    () =>
      latestSaver(
        (raw) => window.go!.main.desktopApp.SaveSettings(raw),
        (cause) => setError(String(cause)),
      ),
    [],
  )
  // Each change applies to the latest settings: two controls used before a
  // render must not undo each other. Loading them is not a change.
  const changed = useRef(false)
  const change = useStableCallback((patch: Partial<DesktopSettings>) => {
    changed.current = true
    setSettings((current) => current && { ...current, ...patch })
  })
  useEffect(() => {
    if (settings && changed.current) save(JSON.stringify(settings))
  }, [settings, save])
  useEffect(() => {
    debugLog.configure(settings?.debugLogging ?? false)
    if (settings?.debugLogging) return startDebugActions('settings')
  }, [settings?.debugLogging])
  const title = PANES.find(({ id }) => id === pane)!.label
  useEffect(() => {
    window.runtime?.WindowSetTitle(title)
  }, [title])

  return (
    <div
      className="desktop-shell settings-window"
      style={settings ? codeVariables(settings) : undefined}
    >
      <style>{desktopStyles}</style>
      <header className="settings-toolbar">
        <h1>{title}</h1>
        <nav className="settings-panes" aria-label="Settings">
          {PANES.map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              aria-current={pane === id ? 'page' : undefined}
              onClick={() => setPane(id)}
            >
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>
      <main className="settings-pane">
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        {settings && pane === 'appearance' && (
          <AppearancePane settings={settings} onChange={change} />
        )}
        {settings && pane === 'code' && <CodePane settings={settings} onChange={change} />}
        {settings && pane === 'window' && (
          <>
            <WindowPane settings={settings} onChange={change} />
            <DebugLogging settings={settings} onChange={change} />
          </>
        )}
        {settings && pane === 'intelligence' && (
          <IntelligencePane settings={settings} onChange={change} />
        )}
        {settings && pane === 'github' && <GitHubPane settings={settings} onChange={change} />}
      </main>
    </div>
  )
}

interface PaneProps {
  settings: DesktopSettings
  onChange: (patch: Partial<DesktopSettings>) => void
}

function DebugLogging({ settings, onChange }: PaneProps) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  return (
    <>
      <h2 className="settings-heading">Diagnostics</h2>
      <div className="settings-group">
        <label className="settings-field">
          <span className="settings-label">
            Debug logging
            <small>
              Record clicks, mouse buttons, keyboard actions, navigation and scroll positions on
              this Mac. Typed text, clipboard contents and source code are not recorded.
            </small>
          </span>
          <input
            type="checkbox"
            checked={settings.debugLogging}
            onChange={(event) => onChange({ debugLogging: event.target.checked })}
          />
        </label>
        <div className="settings-field">
          <span className="settings-label">
            Debug logs
            <small>
              All recorded events are kept in debug.log beside settings.json until you clear them.
              Enable logging, reproduce the issue, then copy the logs.
            </small>
          </span>
          <button
            type="button"
            className="button"
            onClick={async () => {
              try {
                await copyDebugLogs()
                setError(false)
                setMessage('Debug logs copied.')
              } catch {
                setError(true)
                setMessage('Could not copy debug logs. Try again.')
              }
            }}
          >
            Copy debug logs
          </button>
          <button
            type="button"
            className="button"
            onClick={async () => {
              try {
                await debugLog.clear()
                setError(false)
                setMessage('Debug logs cleared.')
              } catch {
                setError(true)
                setMessage('Could not clear debug logs. Try again.')
              }
            }}
          >
            Clear
          </button>
        </div>
      </div>
      {message && <p role={error ? 'alert' : 'status'}>{message}</p>}
    </>
  )
}

function AppearancePane({ settings, onChange }: PaneProps) {
  return (
    <>
      <div className="settings-group">
        <div className="settings-field">
          <span className="settings-label">
            Appearance
            <small>System follows macOS.</small>
          </span>
          <div className="settings-choices" role="group" aria-label="Appearance">
            {APPEARANCES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={settings.appearance === value}
                onClick={() => onChange({ appearance: value })}
              >
                <span className={`appearance-thumb ${value}`} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        </div>
        {(['light', 'dark'] as const).map((mode) => (
          <label className="settings-field" key={mode}>
            <span className="settings-label">
              {mode === 'light' ? 'Light' : 'Dark'} syntax theme
            </span>
            <select
              value={settings[mode]}
              onChange={(event) => {
                const theme = event.target.value as ThemeId
                onChange(mode === 'light' ? { light: theme } : { dark: theme })
              }}
            >
              {THEMES.filter((theme) => theme.mode === mode).map((theme) => (
                <option key={theme.id} value={theme.id}>
                  {theme.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="settings-previews">
        <Preview label="Light" theme={settings.light} />
        <Preview label="Dark" theme={settings.dark} />
      </div>
    </>
  )
}

function CodePane({ settings, onChange }: PaneProps) {
  const listed = (CODE_FONTS as readonly string[]).includes(settings.codeFont)
  const [other, setOther] = useState(!listed)
  const [draftFont, setDraftFont] = useState(listed ? '' : settings.codeFont)
  const available = useMemo(() => installed(settings.codeFont), [settings.codeFont])
  // A new font restyles the whole diff: apply a typed name once it settles.
  useEffect(() => {
    const font = draftFont.trim()
    if (!other || !isFontName(font) || font === settings.codeFont) return
    const timer = setTimeout(() => onChange({ codeFont: font }), 300)
    return () => clearTimeout(timer)
  }, [other, draftFont, settings.codeFont, onChange])

  return (
    <>
      <div className="settings-group">
        <label className="settings-field">
          <span className="settings-label">
            Font
            <small className={available ? undefined : 'unavailable'}>
              {available
                ? 'Any monospaced font installed on this Mac.'
                : `${settings.codeFont} is not installed — using SF Mono.`}
            </small>
          </span>
          <select
            value={other ? 'other' : settings.codeFont}
            onChange={(event) => {
              const font = event.target.value
              setOther(font === 'other')
              if (font !== 'other') onChange({ codeFont: font })
            }}
          >
            {CODE_FONTS.map((font) => (
              <option key={font}>{font}</option>
            ))}
            <option value="other">Other…</option>
          </select>
        </label>
        {other && (
          <label className="settings-field">
            <span className="settings-label">Font name</span>
            <input
              className="font-name"
              value={draftFont}
              placeholder="Berkeley Mono"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              onChange={(event) => setDraftFont(event.target.value)}
            />
          </label>
        )}
        <div className="settings-field">
          <span className="settings-label">Size</span>
          <span className="stepper">
            <button
              type="button"
              aria-label="Smaller"
              disabled={settings.codeSize <= CODE_SIZE.min}
              onClick={() => onChange({ codeSize: settings.codeSize - 1 })}
            >
              −
            </button>
            <output aria-live="polite">{settings.codeSize} pt</output>
            <button
              type="button"
              aria-label="Larger"
              disabled={settings.codeSize >= CODE_SIZE.max}
              onClick={() => onChange({ codeSize: settings.codeSize + 1 })}
            >
              +
            </button>
          </span>
        </div>
      </div>
      <Preview label="Preview" theme={activeTheme(settings)} />
    </>
  )
}

function WindowPane({ settings, onChange }: PaneProps) {
  return (
    <div className="settings-group">
      <div className="settings-field">
        <span className="settings-label">
          Title bar
          <small>Applies the next time Diffdesk opens.</small>
        </span>
        <div className="settings-choices" role="group" aria-label="Title bar">
          {TITLE_BARS.map(({ compact, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={settings.compactTitleBar === compact}
              onClick={() => onChange({ compactTitleBar: compact })}
            >
              <span className={`titlebar-thumb${compact ? ' compact' : ''}`} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const LANGUAGE_LABELS: Record<LanguageId, string> = {
  go: 'Go',
  typescript: 'TypeScript',
  python: 'Python',
  terraform: 'Terraform',
  helm: 'Helm',
  rust: 'Rust',
}

/** Where the server comes from, or why there is none. */
function serverDetail(language: LanguageStatus | undefined): string {
  if (!language) return "Open a review to see its checkout's server."
  if (language.state === 'failed' && language.error)
    return language.error.split('\n')[0]!.slice(0, 160)
  if (!language.server)
    return language.state === 'off' ? 'Off' : `Not found — ${language.install ?? 'not installed'}`
  const path = homeRelative(language.server.path)
  return language.server.origin === 'checkout' ? `${path} · from this checkout` : path
}

/** The review the main window shows, whose checkout decides which servers would run. */
function useShownRepository(): string | null {
  const [repoId, setRepoId] = useState<string | null>(null)
  useEffect(() => {
    const read = async () => {
      const tabs = await window.go?.main.desktopApp.Tabs()
      const shown = tabs?.tabs.find((tab) => tab.id === tabs.active)
      setRepoId(shown ? (new URL(shown.route, location.href).pathname.split('/')[2] ?? null) : null)
    }
    read().catch(() => setRepoId(null))
  }, [])
  return repoId
}

function IntelligencePane({ settings, onChange }: PaneProps) {
  const repoId = useShownRepository()
  // The review sends the settings to the review server when Go hands them over;
  // sending them from here too lets this list follow a change at once.
  const config = languageConfig(settings)
  const sent = useRef(config)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (config === sent.current) return
    sent.current = config
    let current = true
    const send = async () => {
      await sendLanguageConfig(config)
      if (current) setRevision((count) => count + 1)
    }
    // The review shows a failure to send.
    send().catch(() => {})
    return () => {
      current = false
    }
  }, [config])
  const [status] = useLanguageStatus(repoId, revision)
  return (
    <>
      <div className="settings-group">
        <label className="settings-field">
          <span className="settings-label">
            <span>
              Use language servers <span className="beta-badge">Beta</span>
            </span>
            <small>
              Hold ⌘ over a symbol for its type, ⌘-click for its definition, on any branch or
              commit. The servers run on the reviewed code, as your editor would.
            </small>
          </span>
          <input
            type="checkbox"
            checked={settings.codeIntelligence}
            onChange={(event) => onChange({ codeIntelligence: event.target.checked })}
          />
        </label>
        <label className="settings-field">
          <span className="settings-label">
            Symbol panel
            <small>References in a Symbol tab beside Comments.</small>
          </span>
          <input
            type="checkbox"
            checked={settings.symbolPanel}
            onChange={(event) => onChange({ symbolPanel: event.target.checked })}
          />
        </label>
      </div>
      <h2 className="settings-heading">Language servers</h2>
      <div className="settings-group language-servers">
        {(Object.keys(LANGUAGE_SERVERS) as LanguageId[]).map((id) => {
          const language = status?.languages.find((entry) => entry.id === id)
          const server = language?.server
          const unavailable = language?.state === 'missing' || language?.state === 'failed'
          return (
            <label className="settings-field language-server" data-language={id} key={id}>
              <span className="settings-label">
                <span>
                  {LANGUAGE_LABELS[id]}
                  {server && ` · ${server.name}${language.version ? ` ${language.version}` : ''}`}
                </span>
                <small className={unavailable ? 'unavailable' : undefined}>
                  {serverDetail(language)}
                </small>
              </span>
              {language && (
                <span className="server-state" data-state={language.state}>
                  {stateLabel(language)}
                </span>
              )}
              <select
                aria-label={`${LANGUAGE_LABELS[id]} language server`}
                value={settings.languageServers[id]}
                onChange={(event) =>
                  onChange({
                    languageServers: { ...settings.languageServers, [id]: event.target.value },
                  })
                }
              >
                {LANGUAGE_SERVERS[id].map((choice) => (
                  <option key={choice} value={choice}>
                    {SERVER_CHOICE_LABELS[choice] ?? choice}
                  </option>
                ))}
              </select>
            </label>
          )
        })}
      </div>
    </>
  )
}

/** Why pull requests show, or why they cannot. */
function accountNote(account: GitHubAccount | null): string {
  switch (account?.github) {
    case 'ready':
      return `From the GitHub CLI, signed in as ${account.login}.`
    case 'missing':
      return 'Needs the GitHub CLI: brew install gh, then gh auth login.'
    case 'signed-out':
      return 'The GitHub CLI is not signed in: run gh auth login in a terminal.'
    case 'unavailable':
      return `The GitHub CLI did not answer. ${account.message ?? ''}`
    default:
      return 'From the GitHub CLI.'
  }
}

function GitHubPane({ settings, onChange }: PaneProps) {
  const [account, setAccount] = useState<GitHubAccount | null>(null)
  // Asked each time the pane shows: gh may have been installed or signed in meanwhile.
  useEffect(() => {
    if (!settings.showPullRequests) return
    const controller = new AbortController()
    fetch('/api/github', { signal: controller.signal })
      .then((response) => response.json() as Promise<GitHubAccount>)
      .then(setAccount)
      .catch(() => {
        if (!controller.signal.aborted) setAccount(null)
      })
    return () => controller.abort()
  }, [settings.showPullRequests])
  return (
    <div className="settings-group">
      <label className="settings-field">
        <span className="settings-label">
          Show pull requests
          <small>
            {settings.showPullRequests
              ? accountNote(account)
              : "The reviewed branch's pull request, in the title bar."}
          </small>
        </span>
        <input
          type="checkbox"
          checked={settings.showPullRequests}
          onChange={(event) => onChange({ showPullRequests: event.target.checked })}
        />
      </label>
      {settings.showPullRequests && (
        <div className="settings-field">
          <span className="settings-label">Show it in</span>
          <div className="settings-choices" role="group" aria-label="Show it in">
            {PULL_REQUEST_PLACES.map(({ place, label }) => (
              <button
                key={place}
                type="button"
                aria-pressed={settings.pullRequestPlace === place}
                onClick={() => onChange({ pullRequestPlace: place })}
              >
                <span className={`place-thumb ${place}`} aria-hidden="true">
                  <span />
                </span>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Preview({ label, theme }: { label: string; theme: ThemeId }) {
  const { mode, label: name, syntax } = themeById(theme)
  return (
    <div className={`settings-preview ${mode}`}>
      <div className="settings-preview-head">
        <span>{label}</span>
        <span>{name}</span>
      </div>
      <PatchDiff
        patch={PREVIEW}
        options={{ theme: syntax, diffStyle: 'unified', disableFileHeader: true }}
      />
    </div>
  )
}
