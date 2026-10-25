import { activeTheme } from '../web/src/appearance.ts'
import { DEFAULT_SETTINGS, latestSaver, readSettings } from '../web/src/desktopSettings.ts'
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
      compactTitleBar: true,
      codeIntelligence: true,
      symbolPanel: false,
      languageServers: {
        go: 'off',
        typescript: 'tsrs',
        python: 'ty',
        terraform: 'auto',
        helm: 'off',
        rust: 'auto',
      },
      showPullRequests: false,
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
      compactTitleBar: true,
      codeIntelligence: true,
      symbolPanel: false,
      languageServers: {
        go: 'off',
        typescript: 'tsrs',
        python: 'ty',
        terraform: 'auto',
        helm: 'off',
        rust: 'auto',
      },
      showPullRequests: false,
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
      compactTitleBar: 'yes',
      codeIntelligence: 1,
      symbolPanel: 'no',
      // A Go setting may not name a TypeScript server, nor any setting a language Go does not know.
      languageServers: { go: 'tsrs', cobol: 'auto' },
      showPullRequests: 'no',
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

  // Go may answer two saves in flight in either order: a burst waits for the
  // first save, then sends only the last change.
  const saved: string[] = []
  const pending: (() => void)[] = []
  const save = latestSaver(
    (raw) => {
      saved.push(raw)
      return new Promise<void>((resolve) => pending.push(resolve))
    },
    () => {},
  )
  save('12 pt')
  save('13 pt')
  save('14 pt')
  while (pending.length) {
    pending.shift()!()
    await new Promise((resolve) => setTimeout(resolve))
  }
  check(
    'a burst of changes saves the first and the last, one at a time',
    saved.join() === '12 pt,14 pt',
    saved.join(),
  )
}

function sameAs(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
