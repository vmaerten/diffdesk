import { asMarkdown } from '../../../../src/export.ts'
import type { ServedComment } from '../../../../src/types.ts'
import type { DemoComment, DemoLayer } from './fixtures.ts'

export const rangeOf = (layer: DemoLayer) => `${layer.base}...${layer.branch}`

export function codeOf(
  layer: DemoLayer,
  { path, side, start, end }: Omit<DemoComment, 'id' | 'body'>,
): string[] {
  const file = layer.files.find((candidate) => candidate.path === path)!
  const text = side === 'deletions' ? (file.before ?? '') : file.after
  return text.split('\n').slice(start - 1, end)
}

/** What `ghl comments` prints for this layer's comments, through the app's own export. */
export function exportComments(layer: DemoLayer, comments: DemoComment[]): string {
  const range = rangeOf(layer)
  const served: ServedComment[] = comments.map((comment) => {
    const code = codeOf(layer, comment)
    return {
      ...comment,
      anchor: code,
      code,
      stale: false,
      range,
      branch: layer.branch,
      createdAt: '',
    }
  })
  return asMarkdown(served, { range })
}
