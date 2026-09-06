import type { FileDiffMetadata } from '@pierre/diffs'

import type { DiffSide } from '../../src/types.ts'

export interface SearchableDiffItem {
  id: string
  path: string
  collapsed?: boolean
  fileDiff: FileDiffMetadata
}

export type DiffSearchMatch =
  | { type: 'path'; id: string; path: string }
  | {
      type: 'line'
      id: string
      path: string
      side: DiffSide
      lineNumber: number
      text: string
    }

/**
 * Search the parsed patch rather than the mounted nodes of CodeView.
 *
 * One result is one visible row. Context exists on both sides of a diff, but is
 * painted once in unified mode, so it is deliberately indexed only once.
 */
export function searchDiff(
  items: readonly SearchableDiffItem[],
  rawQuery: string,
): DiffSearchMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return []

  const matches: DiffSearchMatch[] = []
  const contains = (value: string | undefined) =>
    value?.toLocaleLowerCase().includes(query) ?? false

  for (const item of items) {
    const diff = item.fileDiff
    if (contains(item.path) || contains(diff.prevName)) {
      matches.push({ type: 'path', id: item.id, path: item.path })
    }

    // A viewed file exposes only its header. Indexing hidden lines would find a
    // result that CodeView cannot reveal without changing the viewed state.
    if (item.collapsed) continue

    for (const hunk of diff.hunks) {
      let deletionLineNumber = hunk.deletionStart
      let additionLineNumber = hunk.additionStart

      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let index = 0; index < content.lines; index++) {
            const text = diff.additionLines[content.additionLineIndex + index] ?? ''
            if (contains(text)) {
              matches.push({
                type: 'line',
                id: item.id,
                path: item.path,
                side: 'additions',
                lineNumber: additionLineNumber + index,
                text,
              })
            }
          }
          deletionLineNumber += content.lines
          additionLineNumber += content.lines
          continue
        }

        for (let index = 0; index < content.deletions; index++) {
          const text = diff.deletionLines[content.deletionLineIndex + index] ?? ''
          if (contains(text)) {
            matches.push({
              type: 'line',
              id: item.id,
              path: item.path,
              side: 'deletions',
              lineNumber: deletionLineNumber + index,
              text,
            })
          }
        }
        for (let index = 0; index < content.additions; index++) {
          const text = diff.additionLines[content.additionLineIndex + index] ?? ''
          if (contains(text)) {
            matches.push({
              type: 'line',
              id: item.id,
              path: item.path,
              side: 'additions',
              lineNumber: additionLineNumber + index,
              text,
            })
          }
        }
        deletionLineNumber += content.deletions
        additionLineNumber += content.additions
      }
    }
  }

  return matches
}
