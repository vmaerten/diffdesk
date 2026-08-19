import { prepareFileTreeInput } from '@pierre/trees'

/**
 * The tree's order, over the whole paths the diff pane lists flat.
 *
 * The diff arrives in patch order — a bytewise sort of whole paths, where `/`
 * beats every letter — while the tree is a hierarchy grouping directories first.
 * The two disagree from the very first row, a file at the root being first in
 * one and last in the other, so `j`/`k` walked an order the eye was not
 * following.
 *
 * This asks the tree's own library for that order instead of restating its rule.
 * `prepareFileTreeInput` is the sort the tree runs on the paths it is handed —
 * the same call, on the same list — and it returns them untouched, neither
 * normalised nor deduplicated, so every path comes back to be found here. The
 * rule it applies is not one anybody would write twice by accident: names are
 * lowercased, split into natural tokens so `Widget2` precedes `Widget10`, and
 * then compared by code unit, which ranks `.` `-` `_` and accents nothing like
 * ICU collation does.
 */
export const treeOrder = (paths: readonly string[]): Map<string, number> =>
  new Map(prepareFileTreeInput(paths).paths.map((path, index) => [path, index]))
