/**
 * Turning comments into something to hand over.
 *
 * What Copy puts on the clipboard. Shared golden fixtures keep it identical to
 * what `diffdesk comments` prints for the same review.
 */

import type { Comment, ServedComment } from './types.ts'

/** A comment on no lines: on its whole file, or on the whole review when it has no path either. */
export const wholeFile = (comment: Pick<Comment, 'start' | 'end'>) =>
  comment.start === 0 && comment.end === 0

/**
 * Path first, then line: the order a reader would take the file in.
 *
 * UTF-16 path order keeps exports identical across locales and runtimes.
 * Not the tree's order. That one exists so `j`/`k` follow the eye down a rendered
 * pane, and there is no pane here.
 */
const inReadingOrder = (comments: ServedComment[]): ServedComment[] =>
  comments.toSorted(
    (left, right) =>
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) || left.start - right.start,
  )

/**
 * The same thing to read rather than to parse, sized for an agent.
 *
 * Each comment gives its ID, `path:lines` and text. Its lines are quoted only
 * when the file no longer has them: removed by the change (`code:`), or changed
 * since the remark was written (`was:`). An agent reads the rest in the file it
 * is about to edit, and every quoted line would cost it tokens twice.
 *
 * No instruction to the reader either — "apply these" is the prompt of whoever
 * pastes this, and it is not this tool's place to write it for them.
 */
export function asText(comments: ServedComment[], { range }: { range: string }): string {
  if (comments.length === 0) return `No comments on ${range}.\n`

  const out = [`${comments.length} comment${comments.length > 1 ? 's' : ''} on ${range}`]
  const block = (label: string, lines: string[]) =>
    out.push(`${label}:`, ...lines.map((line) => `  ${line}`))

  for (const comment of inReadingOrder(comments)) {
    // The ID is what `diffdesk comments resolve` and `reopen` take back.
    const lines = comment.start === comment.end ? comment.start : `${comment.start}-${comment.end}`
    const location = !wholeFile(comment)
      ? `${comment.path}:${lines}`
      : comment.path
        ? `${comment.path} (whole file)`
        : '(whole review)'
    const removed = comment.side === 'deletions' ? ' (removed lines)' : ''
    const status = comment.status && comment.status !== 'open' ? ` · ${comment.status}` : ''
    out.push('', `${comment.id.slice(0, 8)} ${location}${removed}${status}`)
    out.push(comment.body)
    if (comment.side === 'deletions' && comment.code.length > 0) block('code', comment.code)
    if ((comment.stale || comment.code.length === 0) && comment.anchor.length > 0)
      block('was', comment.anchor)
  }

  return out.join('\n') + '\n'
}
