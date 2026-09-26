import { useState } from 'react'

export const THEMES = [
  { id: 'github-dimmed', label: 'GitHub Dark dimmed', syntax: 'github-dark-dimmed' },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappé', syntax: 'catppuccin-frappe' },
  { id: 'github-dark', label: 'GitHub Dark', syntax: 'github-dark-default' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export type SyntaxTheme = (typeof THEMES)[number]['syntax']
const DEFAULT_THEME: ThemeId = 'github-dimmed'
const STORAGE_KEY = 'ghl.theme.v1'

function isTheme(value: string | null | undefined): value is ThemeId {
  return THEMES.some((theme) => theme.id === value)
}

export function readTheme(): ThemeId {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isTheme(value) ? value : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

/** Apply the saved palette before mounting React. */
export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
}

export function useTheme() {
  const [theme, setTheme] = useState(readTheme)
  const chooseTheme = (value: string) => {
    if (!isTheme(value)) return
    applyTheme(value)
    setTheme(value)
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // The selection still works for this tab when browser storage is unavailable.
    }
  }
  const syntaxTheme = THEMES.find((entry) => entry.id === theme)!.syntax
  return { theme, syntaxTheme, chooseTheme }
}
