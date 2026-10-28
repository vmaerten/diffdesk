import { useEffect, useId, useRef, type ReactNode } from 'react'

/** A macOS sheet: a modal dialog over the window, closed by Escape or Done. `actions` sit before Done. */
export default function DesktopSheet({
  open,
  title,
  className,
  onClose,
  actions,
  children,
}: {
  open: boolean
  title: string
  className: string
  onClose: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal()
    else if (!open && dialog.current?.open) dialog.current.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      className={`desktop-sheet ${className}`}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="desktop-sheet-body">{children}</div>
      <footer>
        {actions}
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </dialog>
  )
}
