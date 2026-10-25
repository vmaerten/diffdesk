import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Command, useCommandState } from 'cmdk'

import Icon from './Icon.tsx'
import type { CommandEntry, CommandName } from './commands.ts'
import { matchedRanges } from './paletteMatch.ts'

export interface PaletteCommand extends CommandEntry {
  /** Set on a command that shows a state, as a menu item's check mark would. */
  checked?: boolean
}

export interface PaletteHandle {
  open: () => void
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of matchedRanges(text, query)) {
    parts.push(text.slice(at, start), <mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  parts.push(text.slice(at))
  return parts
}

function Count() {
  const count = useCommandState((state) => state.filtered.count)
  return (
    <span className="palette-count">
      {count} {count === 1 ? 'command' : 'commands'}
    </span>
  )
}

/** Mounted on each opening, so the search starts empty. */
function PaletteBody({
  commands,
  onRun,
}: {
  commands: PaletteCommand[]
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
          placeholder="Search commands…"
        />
        <kbd>esc</kbd>
      </div>
      <Command.List className="palette-list">
        <Command.Empty className="palette-empty">No matching command.</Command.Empty>
        <Command.Group heading="Commands" className="palette-group">
          {commands.map((command) => (
            <Command.Item
              key={command.name}
              className="palette-item"
              value={command.label}
              keywords={[command.group]}
              aria-checked={command.checked}
              onSelect={() => onRun(command.name)}
            >
              <span className="palette-check">{command.checked && <Icon name="check" />}</span>
              <span className="palette-label">
                <Highlighted text={command.label} query={search} />
              </span>
              <span className="palette-meta">
                {command.group}
                {command.keys && <kbd>{command.keys}</kbd>}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="palette-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Move
        </span>
        <span>
          <kbd>↵</kbd> Run
        </span>
        <Count />
      </div>
    </Command>
  )
}

/** ⌘K: the commands that apply to the review shown, found by name. */
export default function CommandPalette({
  handle,
  commands,
  onRun,
}: {
  handle: Ref<PaletteHandle>
  /** Read only while the palette is open. */
  commands: () => PaletteCommand[]
  onRun: (name: CommandName) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  // Shown before returning: the close event of the last opening can come a
  // while after it, and must find the dialog open rather than close it again.
  useImperativeHandle(
    handle,
    () => ({
      open: () => {
        flushSync(() => setOpen(true))
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
    setOpen(false)
  }
  // Closed before the command runs: closing hands the focus back, and a picker
  // the command opens takes it from there instead of losing it to the dialog.
  const run = (name: CommandName) => {
    close()
    onRun(name)
  }
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      // Escape, told at once: the close event that follows can come late.
      onCancel={() => setOpen(false)}
      onClose={() => {
        if (!dialog.current?.open) setOpen(false)
      }}
      // A click on the backdrop lands on the dialog itself, which the body fills.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      {open && <PaletteBody commands={commands()} onRun={run} />}
    </dialog>
  )
}
