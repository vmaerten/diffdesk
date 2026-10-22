import { useState } from 'react'

export const THEMES = [
  { id: 'github-dimmed', label: 'GitHub Dark dimmed', syntax: 'github-dark-dimmed', mode: 'dark' },
  { id: 'github-dark', label: 'GitHub Dark', syntax: 'github-dark-default', mode: 'dark' },
  { id: 'vscode-dark', label: 'VS Code Dark+', syntax: 'dark-plus', mode: 'dark' },
  { id: 'darcula', label: 'JetBrains Darcula', syntax: 'ghl-darcula', mode: 'dark' },
  {
    id: 'catppuccin-frappe',
    label: 'Catppuccin Frappé',
    syntax: 'catppuccin-frappe',
    mode: 'dark',
  },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', syntax: 'catppuccin-mocha', mode: 'dark' },
  { id: 'github-light', label: 'GitHub Light', syntax: 'github-light-default', mode: 'light' },
  { id: 'vscode-light', label: 'VS Code Light+', syntax: 'light-plus', mode: 'light' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', syntax: 'catppuccin-latte', mode: 'light' },
  { id: 'solarized-light', label: 'Solarized Light', syntax: 'solarized-light', mode: 'light' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']
export type SyntaxTheme = (typeof THEMES)[number]['syntax']
const DEFAULT_THEME: ThemeId = 'github-dimmed'
const STORAGE_KEY = 'ghl.theme.v1'

export const themeById = (id: ThemeId) => THEMES.find((entry) => entry.id === id)!

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
  document.documentElement.dataset.colorMode = themeById(theme).mode
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
  const syntaxTheme = themeById(theme).syntax
  return { theme, syntaxTheme, chooseTheme }
}
