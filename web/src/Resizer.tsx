import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

const MIN = 180
const DEFAULT = 272
/** Always leave room for the diff, whatever the window is. */
const max = () => Math.max(MIN, Math.min(700, window.innerWidth - 420))
const clamp = (value: number) => Math.max(MIN, Math.min(value, max()))

export const storedWidth = (): number => {
  const stored = Number(localStorage.getItem('ghl.sidebarWidth'))
  return stored ? clamp(stored) : DEFAULT
}

/**
 * The drag handle between the tree and the diff.
 *
 * The drag never goes through React: it writes the width straight onto the
 * container as a custom property, and only commits to state when the pointer is
 * released. Re-rendering on every mousemove would re-render `CodeView`, whose
 * virtual window is the most expensive thing on the page.
 */
interface ResizerProps {
  containerRef: RefObject<HTMLElement | null>
  onCommit: (width: number) => void
}

export default function Resizer({ containerRef, onCommit }: ResizerProps) {
  const widthRef = useRef<number | null>(null)

  const apply = useCallback(
    (width: number) => {
      widthRef.current = width
      containerRef.current?.style.setProperty('--sidebar-width', `${width}px`)
    },
    [containerRef],
  )

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const sidebar = containerRef.current?.querySelector('.sidebar')
      if (!sidebar) return

      const startX = event.clientX
      const startWidth = sidebar.getBoundingClientRect().width
      event.preventDefault()
      // Stops the drag from selecting the diff, and keeps the cursor from
      // flickering back to `text` over whatever the pointer crosses.
      document.body.classList.add('resizing')
      // A press that never moves must not commit the previous drag's width.
      widthRef.current = null

      const onMove = (move: globalThis.PointerEvent) =>
        apply(clamp(startWidth + move.clientX - startX))
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('resizing')
        if (widthRef.current != null) onCommit(widthRef.current)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [apply, containerRef, onCommit],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 50 : 10
      const sidebar = containerRef.current?.querySelector('.sidebar')
      if (!sidebar) return
      const current = sidebar.getBoundingClientRect().width

      let next: number | null = null
      if (event.key === 'ArrowLeft') next = current - step
      else if (event.key === 'ArrowRight') next = current + step
      else if (event.key === 'Home') next = DEFAULT
      else return

      event.preventDefault()
      event.stopPropagation()
      onCommit(clamp(next))
    },
    [containerRef, onCommit],
  )

  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(DEFAULT)}
      title="Drag to resize, double-click to reset"
    />
  )
}
