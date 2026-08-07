import { useEffect, useState } from 'react'
import { Command } from 'cmdk'

/**
 * Picker for the revision to diff against.
 *
 * Searchable rather than a plain list: repositories here carry up to 501 refs.
 * Refs arrive ordered by commit date, so what you last worked on sits on top
 * before you type anything.
 */
export default function BaseSelector({ repoId, current, source, onPick, onClose }) {
  const [refs, setRefs] = useState(null)
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState({})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch(`/r/${repoId}/api/refs`)
        const body = await response.json()
        if (cancelled) return
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        setRefs(body.refs)
        setMeta({ trunk: body.trunk, branch: body.branch })
      } catch (cause) {
        if (!cancelled) setError(cause.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoId])

  // Escape closes; the dialog owns the key while it is open.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Anchored under the base button, not a centred modal: this is a combobox
  // attached to a value, not a command palette. The backdrop only exists to
  // catch the outside click.
  return (
    <>
      <div className="picker-backdrop" onMouseDown={onClose} />
      <div className="picker" onMouseDown={(event) => event.stopPropagation()}>
        <Command label="Choose a base" loop>
          <Command.Input autoFocus placeholder="Search branches…" className="picker-input" />

          <Command.List className="picker-list">
            {error && <div className="picker-empty">{error}</div>}
            {!refs && !error && <div className="picker-empty">Loading refs…</div>}
            <Command.Empty className="picker-empty">No matching ref.</Command.Empty>

            {(refs ?? []).map((ref) => (
              <Command.Item
                key={ref.name}
                value={ref.name}
                onSelect={() => onPick(ref.name)}
                className="picker-item"
              >
                <span className="picker-name">{ref.name}</span>
                {ref.name === meta.trunk && <span className="badge">trunk</span>}
                {ref.name === meta.branch && <span className="badge">current</span>}
                {ref.name === current && <span className="badge on">base</span>}
                <span className="picker-when">{ref.when}</span>
              </Command.Item>
            ))}
          </Command.List>

          <div className="picker-foot">
            base: <code>{current}</code> ({source}) · <kbd>↵</kbd> pick · <kbd>esc</kbd> close
          </div>
        </Command>
      </div>
    </>
  )
}
