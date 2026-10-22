import { useEffect, useState } from 'react'
import { applyTheme, themeById, type SyntaxTheme, type ThemeId } from './theme.ts'

export type Appearance = 'system' | 'light' | 'dark'

/** The desktop app's choice: one theme per color mode, picked by the appearance. */
export interface AppearanceSettings {
  appearance: Appearance
  light: ThemeId
  dark: ThemeId
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  appearance: 'system',
  light: 'github-light',
  dark: 'github-dimmed',
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)')

export function activeTheme(settings: AppearanceSettings, dark = systemDark().matches): ThemeId {
  const mode = settings.appearance === 'system' ? (dark ? 'dark' : 'light') : settings.appearance
  return settings[mode]
}

/** Applies the active theme, following macOS while the appearance is System. */
export function useAppearance(settings: AppearanceSettings): SyntaxTheme {
  const [dark, setDark] = useState(() => systemDark().matches)
  useEffect(() => {
    const media = systemDark()
    const update = () => setDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const theme = activeTheme(settings, dark)
  useEffect(() => applyTheme(theme), [theme])
  return themeById(theme).syntax
}
