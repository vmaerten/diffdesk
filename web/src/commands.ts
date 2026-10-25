import type { Picker } from './ComparisonControls.tsx'

/** The commands on one file: the active one from the menus, the clicked one from its context menu. */
export type FileCommand = 'viewed' | 'copy-path' | 'reveal'

/**
 * Named commands. Keys send review commands; in the desktop app, every menu
 * item arrives as a `desktop:command` event naming one of these, the names Go
 * writes in desktop/main.go, and so does every command run from the palette.
 * The file context menu sends `desktop:file-command` with the file
 * (desktop/filemenu.go).
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
  | 'palette'

/** Go's menus open a repository and Settings themselves; only the palette sends those two. */
export type WindowCommand =
  | 'reload'
  | 'close-tab'
  | 'shortcuts'
  | 'sidebar'
  | 'open-repository'
  | 'settings'

export type CommandName = ReviewCommand | WindowCommand

export interface CommandEntry {
  name: CommandName
  label: string
  /** The menu that holds it; Refresh, which only has a key, goes with Review. */
  group: string
  /** As macOS menus write it, or the review's single key. */
  keys?: string
}

/**
 * The palette's commands, in the order of the menus. Labels and shortcuts
 * repeat desktop/main.go's, and the single keys App's KEY_COMMANDS.
 */
export const COMMANDS: CommandEntry[] = [
  { name: 'settings', label: 'Settings…', group: 'ghl', keys: '⌘,' },
  { name: 'open-repository', label: 'Open Repository…', group: 'File', keys: '⌘O' },
  { name: 'close-tab', label: 'Close Review', group: 'File', keys: '⌘W' },
  { name: 'sidebar', label: 'Toggle Sidebar', group: 'View', keys: '⌃⌘S' },
  { name: 'reload', label: 'Reload', group: 'View', keys: '⌘R' },
  { name: 'unified', label: 'Unified', group: 'View', keys: '⌘1' },
  { name: 'split', label: 'Split', group: 'View', keys: '⌘2' },
  { name: 'working-tree', label: 'Include Working Tree', group: 'View' },
  { name: 'untracked', label: 'Include Untracked Files', group: 'View' },
  { name: 'whitespace', label: 'Ignore Whitespace', group: 'View', keys: '⌥⌘W' },
  { name: 'comments', label: 'Comments', group: 'View', keys: '⌥⌘0' },
  { name: 'next-file', label: 'Next File', group: 'Go', keys: 'j' },
  { name: 'previous-file', label: 'Previous File', group: 'Go', keys: 'k' },
  { name: 'base', label: 'Choose Base…', group: 'Go', keys: 'b' },
  { name: 'target', label: 'Choose Target…', group: 'Go', keys: 't' },
  { name: 'commit', label: 'Choose Commit…', group: 'Go', keys: 'l' },
  { name: 'stack', label: 'Choose Stack Layer…', group: 'Go', keys: 's' },
  { name: 'layer-below', label: 'Layer Below', group: 'Go', keys: '[' },
  { name: 'layer-above', label: 'Layer Above', group: 'Go', keys: ']' },
  { name: 'viewed', label: 'Mark as Viewed', group: 'Review', keys: 'v' },
  { name: 'comment', label: 'Comment on Selection', group: 'Review', keys: 'c' },
  { name: 'copy-path', label: 'Copy File Path', group: 'Review' },
  { name: 'reveal', label: 'Reveal in Finder', group: 'Review' },
  { name: 'reset-viewed', label: 'Reset Viewed', group: 'Review' },
  { name: 'copy-comments', label: 'Copy All Comments', group: 'Review', keys: '⇧⌘C' },
  { name: 'refresh', label: 'Refresh', group: 'Review', keys: 'r' },
  { name: 'shortcuts', label: 'Keyboard Shortcuts', group: 'Help' },
]

/** Run a command the way a menu item does: App and DesktopApp each take theirs. */
export const sendCommand = (name: CommandName) =>
  window.dispatchEvent(new CustomEvent('desktop:command', { detail: name }))

export const commandOf = (event: Event) => (event as CustomEvent<CommandName>).detail

export const fileCommandOf = (event: Event) =>
  (event as CustomEvent<{ command: FileCommand; path: string }>).detail
