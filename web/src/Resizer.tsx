import { useCallback, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

/**
 * The panes either side of the diff. The side panel grows as its handle moves
 * left, the tree as its handle moves right.
 */
const PANES = {
  sidebar: {
    element: '.sidebar',
    property: '--sidebar-width',
    key: 'ghl.sidebarWidth',
    min: 180,
    initial: 272,
    growth: 1,
    label: 'Resize the file tree',
  },
  panel: {
    element: '.comments-panel:not([hidden])',
    property: '--panel-width',
    key: 'ghl.panelWidth',
    min: 260,
    initial: 320,
    growth: -1,
    label: 'Resize the side panel',
  },
} as const
export type Pane = keyof typeof PANES

/** Always leave room for the diff, whatever the window is. */
const clamp = (pane: Pane, value: number) => {
  const { min } = PANES[pane]
  return Math.max(min, Math.min(value, Math.max(min, Math.min(700, window.innerWidth - 420))))
}

export const storedWidth = (pane: Pane = 'sidebar'): number => {
  const stored = Number(localStorage.getItem(PANES[pane].key))
  return stored ? clamp(pane, stored) : PANES[pane].initial
}

/**
 * The drag handle between the diff and a pane beside it.
 *
 * The drag never goes through React: it writes the width straight onto the
 * container as a custom property, and only commits to state when the pointer is
 * released. Re-rendering on every mousemove would re-render `CodeView`, whose
 * virtual window is the most expensive thing on the page.
 */
interface ResizerProps {
  containerRef: RefObject<HTMLElement | null>
  onCommit: (width: number) => void
  pane?: Pane
}

export default function Resizer({ containerRef, onCommit, pane = 'sidebar' }: ResizerProps) {
  const widthRef = useRef<number | null>(null)
  const { element, property, initial, growth, label } = PANES[pane]

  const apply = useCallback(
    (width: number) => {
      widthRef.current = width
      containerRef.current?.style.setProperty(property, `${width}px`)
    },
    [containerRef, property],
  )

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const sized = containerRef.current?.querySelector(element)
      if (!sized) return

      const startX = event.clientX
      const startWidth = sized.getBoundingClientRect().width
      event.preventDefault()
      // Stops the drag from selecting the diff, and keeps the cursor from
      // flickering back to `text` over whatever the pointer crosses.
      document.body.classList.add('resizing')
      // A press that never moves must not commit the previous drag's width.
      widthRef.current = null

      const onMove = (move: globalThis.PointerEvent) =>
        apply(clamp(pane, startWidth + (move.clientX - startX) * growth))
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('resizing')
        if (widthRef.current != null) onCommit(widthRef.current)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [apply, containerRef, onCommit, element, growth, pane],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = (event.shiftKey ? 50 : 10) * growth
      const sized = containerRef.current?.querySelector(element)
      if (!sized) return
      const current = sized.getBoundingClientRect().width

      let next: number | null = null
      if (event.key === 'ArrowLeft') next = current - step
      else if (event.key === 'ArrowRight') next = current + step
      else if (event.key === 'Home') next = initial
      else return

      event.preventDefault()
      event.stopPropagation()
      onCommit(clamp(pane, next))
    },
    [containerRef, onCommit, element, growth, initial, pane],
  )

  return (
    <div
      className={`resizer ${pane}-resizer`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(initial)}
      title="Drag to resize, double-click to reset"
    />
  )
}
