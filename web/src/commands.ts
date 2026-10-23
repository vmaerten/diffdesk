import type { Picker } from './ComparisonControls.tsx'

/**
 * Named commands. Keys send review commands; in the desktop app, every menu
 * item arrives as a `desktop:command` event naming one of these, the names Go
 * writes in desktop/main.go.
 */
export type ReviewCommand =
  | Picker
  | 'next-file'
  | 'previous-file'
  | 'refresh'
  | 'comment'
  | 'viewed'
  | 'unified'
  | 'split'
  | 'working-tree'
  | 'untracked'
  | 'whitespace'
  | 'comments'
  | 'copy-comments'
  | 'reset-viewed'
  | 'copy-path'
  | 'reveal'

export type WindowCommand = 'reload' | 'close-tab' | 'settings' | 'shortcuts' | 'sidebar'

export const PICKERS: readonly Picker[] = ['base', 'target', 'commit']

export const commandOf = (event: Event) =>
  (event as CustomEvent<ReviewCommand | WindowCommand>).detail
