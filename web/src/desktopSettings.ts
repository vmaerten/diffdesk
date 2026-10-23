import { DEFAULT_APPEARANCE, type Appearance, type AppearanceSettings } from './appearance.ts'
import { THEMES, type ThemeId } from './theme.ts'

export const CODE_FONTS = ['SF Mono', 'Menlo', 'JetBrains Mono', 'Fira Code'] as const
export const CODE_SIZE = { min: 10, max: 18 } as const

export interface DesktopSettings extends AppearanceSettings {
  version: 1
  /** One of CODE_FONTS, or any font installed on the Mac. */
  codeFont: string
  codeSize: number
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  version: 1,
  ...DEFAULT_APPEARANCE,
  codeFont: 'SF Mono',
  codeSize: 12,
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
  const { appearance, codeFont, codeSize } = stored
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
  }
}

/** SF Mono is the system stack (--mono in desktop.css); any other family falls back to it. */
export function codeFontFamily(font: string): string {
  return font === 'SF Mono' ? 'var(--mono)' : `"${font}", var(--mono)`
}

export function codeLineHeight(size: number): number {
  return Math.round(size * 1.65)
}
