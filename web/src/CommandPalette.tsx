import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Command, useCommandState } from 'cmdk'

import Icon from './Icon.tsx'
import type { CommandEntry, CommandName } from './commands.ts'
import type { TreeEntry } from './FileTree.tsx'
import { matchedRanges } from './paletteMatch.ts'
import type { GitStatus } from '../../src/types.ts'

export interface PaletteCommand extends CommandEntry {
  /** Set on a command that shows a state, as a menu item's check mark would. */
  checked?: boolean
}

export type PaletteScope = 'commands' | 'files'

export interface PaletteHandle {
  /** Opens on `scope`, or switches to it when already open. */
  open: (scope: PaletteScope) => void
}

const SCOPES: { scope: PaletteScope; label: string; keys: string }[] = [
  { scope: 'commands', label: 'Commands', keys: '⌘K' },
  { scope: 'files', label: 'Files', keys: '⌘P' },
]

const PLACEHOLDERS: Record<PaletteScope, string> = {
  commands: 'Search commands…',
  files: 'Search files…',
}

const STATUS: Record<GitStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: 'U',
}

/** `text` from `start` to `end`, with the matched ranges marked. */
function Highlighted({
  text,
  ranges,
  start = 0,
  end = text.length,
}: {
  text: string
  ranges: [number, number][]
  start?: number
  end?: number
}) {
  const parts: ReactNode[] = []
  let at = start
  for (const [from, to] of ranges) {
    if (to <= at || from >= end) continue
    parts.push(text.slice(at, Math.max(from, at)))
    parts.push(<mark key={from}>{text.slice(Math.max(from, at), Math.min(to, end))}</mark>)
    at = Math.min(to, end)
  }
  parts.push(text.slice(at, end))
  return parts
}

/** A file's own name when the search matches it, else wherever it matches in the path. */
function fileRanges(path: string, nameStart: number, search: string): [number, number][] {
  const inName = matchedRanges(path.slice(nameStart), search)
  if (inName.length === 0) return matchedRanges(path, search)
  return inName.map(([from, to]) => [from + nameStart, to + nameStart])
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function Count({ word }: { word: string }) {
  const count = useCommandState((state) => state.filtered.count)
  return <span className="palette-count">{plural(count, word)}</span>
}

/** Mounted on each opening, so the search starts empty. */
function PaletteBody({
  scope,
  onScope,
  files,
  commands,
  onOpenFile,
  onRun,
}: {
  scope: PaletteScope
  onScope: (scope: PaletteScope) => void
  files: TreeEntry[]
  commands: PaletteCommand[]
  onOpenFile: (path: string) => void
  onRun: (name: CommandName) => void
}) {
  const [search, setSearch] = useState('')
  return (
    <Command label="Command palette" loop>
      <div className="palette-search">
        <Icon name="search" />
        <Command.Input
          className="palette-input"
          value={search}
          onValueChange={setSearch}
          placeholder={PLACEHOLDERS[scope]}
        />
        <kbd>esc</kbd>
      </div>
      <div className="palette-scopes" role="group" aria-label="Search in">
        {SCOPES.map((option) => (
          <button
            key={option.scope}
            type="button"
            className="palette-scope"
            aria-pressed={scope === option.scope}
            // The search keeps the focus.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onScope(option.scope)}
          >
            {option.label}
            <span className="palette-scope-keys">{option.keys}</span>
          </button>
        ))}
      </div>
      <Command.List className="palette-list">
        <Command.Empty className="palette-empty">
          {scope === 'files' ? 'No matching file.' : 'No matching command.'}
        </Command.Empty>
        {scope === 'commands' &&
          commands.map((command) => (
            <Command.Item
              key={command.name}
              className="palette-item"
              data-kind="command"
              value={command.label}
              keywords={[command.group]}
              aria-checked={command.checked}
              onSelect={() => onRun(command.name)}
            >
              <span className="palette-check">{command.checked && <Icon name="check" />}</span>
              <span className="palette-label">
                <Highlighted text={command.label} ranges={matchedRanges(command.label, search)} />
              </span>
              <span className="palette-meta">
                {command.group}
                {command.keys && <kbd>{command.keys}</kbd>}
              </span>
            </Command.Item>
          ))}
        {scope === 'files' &&
          files.map((file) => {
            const nameStart = file.path.lastIndexOf('/') + 1
            const ranges = fileRanges(file.path, nameStart, search)
            return (
              <Command.Item
                key={file.path}
                className="palette-item"
                data-kind="file"
                data-path={file.path}
                value={file.path}
                onSelect={() => onOpenFile(file.path)}
              >
                <span className="palette-check">
                  <Icon name="file" />
                </span>
                <span className="palette-label palette-file">
                  <Highlighted text={file.path} ranges={ranges} start={nameStart} />
                </span>
                {nameStart > 0 && (
                  <span className="palette-dir">
                    <Highlighted text={file.path} ranges={ranges} end={nameStart - 1} />
                  </span>
                )}
                <span className="palette-meta">
                  {file.viewed && 'Viewed'}
                  {!file.binary && (
                    <span className="palette-stats">
                      {file.additions > 0 && <span className="added">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="deleted">−{file.deletions}</span>}
                    </span>
                  )}
                  <span className={`palette-status ${file.status}`}>{STATUS[file.status]}</span>
                </span>
              </Command.Item>
            )
          })}
      </Command.List>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Move
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <Count word={scope === 'files' ? 'file' : 'command'} />
      </div>
    </Command>
  )
}

/** ⌘K: the commands that apply to the review, found by name; ⌘P: its files. */
export default function CommandPalette({
  handle,
  files,
  commands,
  onOpenFile,
  onRun,
}: {
  handle: Ref<PaletteHandle>
  files: TreeEntry[]
  /** Read only while the palette is open. */
  commands: () => PaletteCommand[]
  onOpenFile: (path: string) => void
  onRun: (name: CommandName) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [scope, setScope] = useState<PaletteScope | null>(null)
  // Shown before returning: the close event of the last opening can come a
  // while after it, and must find the dialog open rather than close it again.
  useImperativeHandle(
    handle,
    () => ({
      open: (next) => {
        flushSync(() => setScope(next))
        const element = dialog.current
        if (element && !element.open) element.showModal()
        // showModal focuses cmdk's root, the first element that takes focus.
        element?.querySelector<HTMLInputElement>('.palette-input')?.focus()
      },
    }),
    [],
  )
  const close = () => {
    dialog.current?.close()
    setScope(null)
  }
  // Closed before acting: closing hands the focus back, and a picker a command
  // opens takes it from there instead of losing it to the dialog.
  const choose = (action: () => void) => {
    close()
    action()
  }
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      // Escape, told at once: the close event that follows can come late.
      onCancel={() => setScope(null)}
      // Late for a palette reopened since: that one stays.
      onClose={() => {
        if (!dialog.current?.open) setScope(null)
      }}
      // A click on the backdrop lands on the dialog itself, which the body fills.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {scope && (
        <PaletteBody
          scope={scope}
          onScope={setScope}
          files={files}
          commands={commands()}
          onOpenFile={(path) => choose(() => onOpenFile(path))}
          onRun={(name) => choose(() => onRun(name))}
        />
      )}
    </dialog>
  )
}
