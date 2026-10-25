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
  latestSaver,
  readSettings,
  type DesktopSettings,
} from './desktopSettings.ts'
import desktopStyles from './desktop.css?inline'

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
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

type Pane = 'appearance' | 'code' | 'window'

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
        {settings && pane === 'window' && <WindowPane settings={settings} onChange={change} />}
      </main>
    </div>
  )
}

interface PaneProps {
  settings: DesktopSettings
  onChange: (patch: Partial<DesktopSettings>) => void
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
          <small>Applies the next time ghl opens.</small>
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
