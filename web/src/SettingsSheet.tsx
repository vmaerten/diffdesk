import { useEffect, useMemo, useState } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { THEMES, themeById, type ThemeId } from './theme.ts'
import DesktopSheet from './DesktopSheet.tsx'
import type { Appearance } from './appearance.ts'
import { CODE_FONTS, CODE_SIZE, isFontName, type DesktopSettings } from './desktopSettings.ts'

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
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

export default function SettingsSheet({
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean
  settings: DesktopSettings
  onChange: (patch: Partial<DesktopSettings>) => void
  onClose: () => void
}) {
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
    <DesktopSheet open={open} title="Settings" className="settings-sheet" onClose={onClose}>
      <h3>Appearance</h3>
      <div className="settings-group">
        <div className="settings-field">
          <span className="settings-label">
            Appearance
            <small>System follows macOS.</small>
          </span>
          <div className="appearance-choices" role="group" aria-label="Appearance">
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

      <h3>Code</h3>
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

      <h3>Window</h3>
      <div className="settings-group">
        <label className="settings-field">
          <span className="settings-label">
            Compact title bar
            <small>Applies the next time ghl opens.</small>
          </span>
          <input
            type="checkbox"
            checked={settings.compactTitleBar}
            onChange={(event) => onChange({ compactTitleBar: event.target.checked })}
          />
        </label>
      </div>

      <h3>Preview</h3>
      <div className="settings-previews">
        {(['light', 'dark'] as const).map((mode) => (
          <div className={`settings-preview ${mode}`} key={mode}>
            <div className="settings-preview-head">
              <span>{mode === 'light' ? 'Light' : 'Dark'}</span>
              <span>{themeById(settings[mode]).label}</span>
            </div>
            {open && (
              <PatchDiff
                patch={PREVIEW}
                options={{
                  theme: themeById(settings[mode]).syntax,
                  diffStyle: 'unified',
                  disableFileHeader: true,
                }}
              />
            )}
          </div>
        ))}
      </div>
    </DesktopSheet>
  )
}
