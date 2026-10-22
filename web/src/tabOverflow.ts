/** A tab's minimum width plus the gap after it, as desktop.css lays them out. */
export const TAB_SLOT = 112
/** Room kept for the » menu once some tabs no longer fit. */
export const MORE_WIDTH = 32

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
