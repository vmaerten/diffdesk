import type { CSSProperties } from 'react'

const TAB_MIN_WIDTH = 110
const TAB_GAP = 2
const TAB_SLOT = TAB_MIN_WIDTH + TAB_GAP
/** Room kept for the » menu once some tabs no longer fit. */
const MORE_WIDTH = 32

/** The sizes the split assumes, handed to desktop.css so the two cannot drift. */
export const tabSizes = {
  '--tab-min-width': `${TAB_MIN_WIDTH}px`,
  '--tab-gap': `${TAB_GAP}px`,
} as CSSProperties

/** Whether two widths fit the same tabs, so a resize between them needs no render. */
export const sameCapacity = (a: number, b: number) =>
  Math.floor(a / TAB_SLOT) === Math.floor(b / TAB_SLOT) &&
  Math.floor((a - MORE_WIDTH) / TAB_SLOT) === Math.floor((b - MORE_WIDTH) / TAB_SLOT)

/** Which tabs fit in the title bar; the active one always does, the rest go to ». */
export function splitTabs(
  count: number,
  active: number,
  width: number,
): { shown: number[]; hidden: number[] } {
  const all = [...Array(count).keys()]
  if (count * TAB_SLOT <= width) return { shown: all, hidden: [] }
  const room = Math.max(1, Math.floor((width - MORE_WIDTH) / TAB_SLOT))
  const shown = all.slice(0, room)
  if (active >= room) shown[room - 1] = active
  return { shown, hidden: all.filter((index) => !shown.includes(index)) }
}
