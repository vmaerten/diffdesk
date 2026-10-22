import { useEffect, useRef } from 'react'
import KeyboardShortcuts from './KeyboardShortcuts.tsx'

export default function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open && dialog.current?.open) dialog.current.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      className="desktop-sheet shortcuts-sheet"
      aria-labelledby="shortcuts-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
      <div className="desktop-sheet-body">
        <KeyboardShortcuts />
      </div>
      <footer>
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  )
}
