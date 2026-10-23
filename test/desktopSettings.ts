import { activeTheme } from '../web/src/appearance.ts'
import { DEFAULT_SETTINGS, readSettings } from '../web/src/desktopSettings.ts'
import type { Check } from './harness.ts'

export async function runDesktopSettings(check: Check): Promise<void> {
  check('nothing stored keeps the defaults', sameAs(readSettings(''), DEFAULT_SETTINGS))

  const stored = readSettings(
    JSON.stringify({
      version: 1,
      appearance: 'dark',
      light: 'solarized-light',
      dark: 'catppuccin-mocha',
      codeFont: 'Berkeley Mono',
      codeSize: 14,
    }),
  )
  check(
    'valid values survive',
    sameAs(stored, {
      version: 1,
      appearance: 'dark',
      light: 'solarized-light',
      dark: 'catppuccin-mocha',
      codeFont: 'Berkeley Mono',
      codeSize: 14,
    }),
  )

  const invalid = readSettings(
    JSON.stringify({
      version: 1,
      appearance: 'sepia',
      light: 'github-dimmed',
      dark: 'no-such-theme',
      codeFont: 'Evil", serif; x',
      codeSize: 40,
    }),
  )
  // The light slot holds a dark theme: each slot only takes its own mode.
  check('each invalid value falls back on its own default', sameAs(invalid, DEFAULT_SETTINGS))

  const themes = { light: 'github-light', dark: 'github-dimmed' } as const
  check(
    'System takes the dark theme under a dark macOS',
    activeTheme({ ...themes, appearance: 'system' }, true) === 'github-dimmed',
  )
  check(
    'a forced appearance ignores macOS',
    activeTheme({ ...themes, appearance: 'light' }, true) === 'github-light',
  )
}

function sameAs(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
