import type { Picker } from './ComparisonControls.tsx'

/** The commands on one file: the active one from the menus, the clicked one from its context menu. */
export type FileCommand = 'viewed' | 'copy-path' | 'reveal'

/**
 * Named commands. Keys send review commands; in the desktop app, every menu
 * item arrives as a `desktop:command` event naming one of these, the names Go
 * writes in desktop/main.go. The file context menu sends `desktop:file-command`
 * with the file (desktop/filemenu.go).
 */
export type ReviewCommand =
  | Picker
  | 'next-file'
  | 'previous-file'
  | 'layer-below'
  | 'layer-above'
  | 'refresh'
  | 'comment'
  | FileCommand
  | 'unified'
  | 'split'
  | 'working-tree'
  | 'untracked'
  | 'whitespace'
  | 'comments'
  | 'copy-comments'
  | 'reset-viewed'

export type WindowCommand = 'reload' | 'close-tab' | 'settings' | 'shortcuts' | 'sidebar'

export const commandOf = (event: Event) =>
  (event as CustomEvent<ReviewCommand | WindowCommand>).detail

export const fileCommandOf = (event: Event) =>
  (event as CustomEvent<{ command: FileCommand; path: string }>).detail
