/**
 * Natural order, digits compared as numbers.
 *
 * `numeric` is not a nicety here, it is what the tree does: plain
 * `localeCompare` gives Widget1, Widget10, Widget11 where the tree gives
 * Widget1, Widget2, Widget3, and the two lists part company at the tenth row.
 */
const collator = new Intl.Collator(undefined, { numeric: true })

/** Directories first, then basename — the convention the tree already follows. */
const compareSiblings = (
  leftName: string,
  leftIsDirectory: boolean,
  rightName: string,
  rightIsDirectory: boolean,
): number => {
  if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1
  return collator.compare(leftName, rightName)
}

/**
 * The tree's order, over the whole paths the diff pane lists flat.
 *
 * The diff arrives in patch order — a bytewise sort of whole paths, where `/`
 * beats every letter — while the tree is a hierarchy grouping directories first.
 * The two disagree from the very first row, a file at the root being first in
 * one and last in the other, so `j`/`k` walked an order the eye was not
 * following.
 *
 * This reproduces the tree's default rather than replacing it. `@pierre/trees`
 * does take a `sort` comparator, but its entries carry `depth` and `segments`,
 * so it is not called on siblings alone: feeding it a sibling rule reorders the
 * tree into something neither pane wanted. The tree keeps its own default and
 * this follows it — with a test comparing the two orders row by row, since a
 * copy of someone else's rule is a copy that can drift.
 *
 * Walks down the shared prefix and decides at the first level where the two
 * differ, which is exactly where the tree shows them apart. A path that ends at
 * that level is a file; one that continues is a directory.
 */
export function compareTreePaths(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareSiblings(a[i] ?? '', i < a.length - 1, b[i] ?? '', i < b.length - 1)
    if (order !== 0) return order
  }
  return a.length - b.length
}
