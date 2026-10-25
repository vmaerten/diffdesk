/**
 * Turning comments into something to hand over.
 *
 * The review panel's Markdown. Shared golden fixtures keep it identical to what
 * `ghl comments` prints for the same review.
 */

import type { ServedComment } from './types.ts'

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

const lineLabel = (comment: ServedComment) =>
  comment.start === comment.end ? `L${comment.start}` : `L${comment.start}–L${comment.end}`

/**
 * The same thing to read rather than to parse.
 *
 * The commented lines are quoted because a path and a line number alone go stale
 * between taking the export and acting on it. The surrounding hunk is not: that
 * is what `git diff` is for, and it would bury the remark it came with.
 *
 * No instruction to the reader either — "apply these" is the prompt of whoever
 * pastes this, and it is not this tool's place to write it for them.
 */
export function asMarkdown(comments: ServedComment[], { range }: { range: string }): string {
  if (comments.length === 0) return `No comments on ${range}.\n`

  const out: string[] = [
    `# ${comments.length} comment${comments.length > 1 ? 's' : ''} on ${range}`,
  ]
  let file: string | null = null

  for (const comment of inReadingOrder(comments)) {
    if (comment.path !== file) {
      file = comment.path
      out.push('', `## ${file}`)
    }
    const status = comment.status && comment.status !== 'open' ? ` · ${comment.status}` : ''
    // The ID is what `ghl comments reply`, `resolve` and `reopen` take back.
    out.push('', `**${lineLabel(comment)}** · ${comment.id.slice(0, 8)}${status}`)
    if (comment.code.length > 0) out.push('', '```', ...comment.code, '```')
    out.push('', comment.body)
    for (const reply of comment.replies ?? []) out.push('', `↳ ${reply.author}: ${reply.body}`)
    if ((comment.stale || comment.code.length === 0) && comment.anchor.length > 0) {
      out.push(
        '',
        comment.code.length === 0
          ? '> Code is unavailable in the current comparison. Original lines:'
          : '> These lines have changed since the remark was written. They read:',
        '',
        '```',
        ...comment.anchor,
        '```',
      )
    }
  }

  return out.join('\n') + '\n'
}
