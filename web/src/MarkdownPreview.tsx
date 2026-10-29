import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { FileDiffContentsLoader, FileDiffMetadata, Hunk } from '@pierre/diffs'

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)

/** The new file's line numbers that the hunks add, 1-based. */
export function addedLines(hunks: Hunk[]): Set<number> {
  const lines = new Set<number>()
  for (const hunk of hunks) {
    let line = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        line += content.lines
        continue
      }
      for (let added = 0; added < content.additions; added++) lines.add(line + added)
      line += content.additions
    }
  }
  return lines
}

interface HastNode {
  type: string
  tagName?: string
  position?: { start: { line: number }; end: { line: number } }
  properties?: Record<string, unknown>
  children?: HastNode[]
}

// Marked through their rows and items: a whole table or list lit up for one
// changed cell says nothing about where the change is.
const CONTAINERS = new Set(['ul', 'ol', 'table', 'thead', 'tbody'])
const isList = (node: HastNode) => node.tagName === 'ul' || node.tagName === 'ol'

/** Flag the top-level blocks, list items and table rows that hold an added line. */
function markChanged(changed: ReadonlySet<number>) {
  const touches = (from: number, to: number) => {
    for (let line = from; line <= to; line++) if (changed.has(line)) return true
    return false
  }
  const visit = (node: HastNode, topLevel: boolean) => {
    for (const child of node.children ?? []) {
      if (child.type !== 'element' || !child.tagName) continue
      const block =
        child.tagName === 'li' ||
        child.tagName === 'tr' ||
        (topLevel && !CONTAINERS.has(child.tagName))
      if (block && child.position) {
        // An item's nested list is marked on its own items, not on the parent's.
        const nested = child.children?.find(isList)?.position
        const end = nested ? nested.start.line - 1 : child.position.end.line
        if (touches(child.position.start.line, end))
          child.properties = { ...child.properties, dataChanged: true }
      }
      if (CONTAINERS.has(child.tagName) || child.tagName === 'li') visit(child, false)
    }
  }
  return () => (tree: HastNode) => visit(tree, true)
}

/**
 * Only web links leave the app; a relative link or an anchor would navigate the
 * review document itself.
 */
function Link({ href, children }: ComponentProps<'a'>) {
  return href && /^(https?:|mailto:)/i.test(href) ? (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ) : (
    <span className="markdown-link">{children}</span>
  )
}

const components = { a: Link }
const remarkPlugins = [remarkGfm]

/**
 * A Markdown file rendered from one side of the comparison, its added blocks
 * marked. Raw HTML and images are left out, as in release notes.
 */
export default function MarkdownPreview({
  load,
  file,
  side,
  changed,
}: {
  load: FileDiffContentsLoader
  file: FileDiffMetadata
  side: 'deletions' | 'additions'
  changed: ReadonlySet<number>
}) {
  const [source, setSource] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    // Never while rendering: the loader reports its state to the pane, which
    // shows a failure with Retry.
    void (async () => {
      const loaded = await load(file)
      if (current)
        setSource(side === 'deletions' ? (loaded.oldFile?.contents ?? '') : loaded.newFile.contents)
    })()
    return () => {
      current = false
    }
  }, [load, file, side])
  const rehypePlugins = useMemo(() => [markChanged(changed)], [changed])
  if (source === null) return <div className="markdown-preview loading">Loading…</div>
  return (
    <div className="markdown-preview" data-side={side}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        disallowedElements={['img']}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  )
}
