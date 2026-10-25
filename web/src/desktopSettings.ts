import type { CSSProperties } from 'react'
import { DEFAULT_APPEARANCE, type Appearance, type AppearanceSettings } from './appearance.ts'
import { THEMES, type ThemeId } from './theme.ts'

export const CODE_FONTS = ['SF Mono', 'Menlo', 'JetBrains Mono', 'Fira Code'] as const
export const CODE_SIZE = { min: 10, max: 18 } as const

/** The languages the review server knows, each with the choices its setting takes. */
export const LANGUAGE_SERVERS = {
  go: ['auto', 'off'],
  typescript: ['auto', 'tsc', 'tsrs', 'typescript-language-server', 'off'],
  rust: ['auto', 'off'],
} as const satisfies Record<string, readonly string[]>
export type LanguageId = keyof typeof LANGUAGE_SERVERS

export interface DesktopSettings extends AppearanceSettings {
  version: 1
  /** One of CODE_FONTS, or any font installed on the Mac. */
  codeFont: string
  codeSize: number
  /** Read by the app when it opens its window: a change applies at the next launch. */
  compactTitleBar: boolean
  /** Beta: hover and definitions from the language servers installed on this Mac. */
  codeIntelligence: boolean
  languageServers: Record<LanguageId, string>
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  version: 1,
  ...DEFAULT_APPEARANCE,
  codeFont: 'SF Mono',
  codeSize: 12,
  compactTitleBar: false,
  codeIntelligence: false,
  languageServers: { go: 'auto', typescript: 'auto', rust: 'auto' },
}

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']

/** A family name that is safe to quote into a CSS font-family list. */
export function isFontName(name: string): boolean {
  return /^[\p{L}\p{N} ._-]{1,64}$/u.test(name)
}

/** Keeps each stored value that is still valid, and the default for the rest. */
export function readSettings(raw: string): DesktopSettings {
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>
  } catch {
    // Nothing stored yet, or nothing readable: the defaults stand.
  }
  const theme = (mode: 'light' | 'dark'): ThemeId => {
    const entry = THEMES.find((option) => option.id === stored[mode] && option.mode === mode)
    return entry ? entry.id : DEFAULT_SETTINGS[mode]
  }
  const { appearance, codeFont, codeSize, compactTitleBar, codeIntelligence, languageServers } =
    stored
  const servers = (
    languageServers && typeof languageServers === 'object' ? languageServers : {}
  ) as Record<string, unknown>
  return {
    version: 1,
    appearance: APPEARANCES.find((value) => value === appearance) ?? DEFAULT_SETTINGS.appearance,
    light: theme('light'),
    dark: theme('dark'),
    codeFont:
      typeof codeFont === 'string' && isFontName(codeFont.trim())
        ? codeFont.trim()
        : DEFAULT_SETTINGS.codeFont,
    codeSize:
      Number.isInteger(codeSize) &&
      (codeSize as number) >= CODE_SIZE.min &&
      (codeSize as number) <= CODE_SIZE.max
        ? (codeSize as number)
        : DEFAULT_SETTINGS.codeSize,
    compactTitleBar:
      typeof compactTitleBar === 'boolean' ? compactTitleBar : DEFAULT_SETTINGS.compactTitleBar,
    codeIntelligence:
      typeof codeIntelligence === 'boolean' ? codeIntelligence : DEFAULT_SETTINGS.codeIntelligence,
    languageServers: Object.fromEntries(
      Object.entries(LANGUAGE_SERVERS).map(([id, choices]) => {
        const choice = servers[id]
        return [id, (choices as readonly unknown[]).includes(choice) ? choice : 'auto']
      }),
    ) as Record<LanguageId, string>,
  }
}

/**
 * Saves one document at a time, and only the latest of those that came in the
 * meantime: Wails runs each call on its own goroutine, so two saves in flight
 * could land in either order.
 */
export function latestSaver(
  save: (raw: string) => Promise<void>,
  failed: (cause: unknown) => void,
): (raw: string) => void {
  let next: string | null = null
  let saving = false
  return (raw) => {
    next = raw
    if (saving) return
    saving = true
    void (async () => {
      while (next !== null) {
        const current = next
        next = null
        await save(current).catch(failed)
      }
      saving = false
    })()
  }
}

/** SF Mono is the system stack (--mono in desktop.css); any other family falls back to it. */
function codeFontFamily(font: string): string {
  return font === 'SF Mono' ? 'var(--mono)' : `"${font}", var(--mono)`
}

export function codeLineHeight(size: number): number {
  return Math.round(size * 1.65)
}

/** The code font and size, as the --code-* properties desktop.css reads. */
export function codeVariables(settings: DesktopSettings): CSSProperties {
  return {
    '--code-font': codeFontFamily(settings.codeFont),
    '--code-size': `${settings.codeSize}px`,
    '--code-line-height': `${codeLineHeight(settings.codeSize)}px`,
  } as CSSProperties
}
