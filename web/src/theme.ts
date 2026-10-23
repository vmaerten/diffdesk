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
export const themeById = (id: ThemeId) => THEMES.find((entry) => entry.id === id)!

/** Apply a palette to the document, before mounting React and on every change. */
export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.colorMode = themeById(theme).mode
}
