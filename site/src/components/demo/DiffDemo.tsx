import {
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DiffSide } from '../../../../src/types.ts'
import { exportComments } from './comments.ts'
import { layers, startLayer, type DemoComment, type DemoFile } from './fixtures.ts'
import StackMenu from './StackMenu.tsx'
import './demo.css'

type DiffStyle = 'unified' | 'split'
type Lines = { path: string; side: DiffSide; start: number; end: number }
type Note = { comment: DemoComment } | { composer: true }
/** What the reviewer changes on a layer: ghl keeps it per branch. */
type LayerState = { viewed: Set<string>; revealed: Set<string>; comments: DemoComment[] }

// The app's default syntax theme for each appearance.
const themes = { light: 'github-light-default', dark: 'github-dark-dimmed' } as const

const reviews = layers.map((layer) => {
  const files = layer.files.map((file) => {
    const diff = parseDiffFromFile(
      file.before === null ? null : { name: file.path, contents: file.before },
      { name: file.path, contents: file.after },
    )
    const additions = diff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0)
    const deletions = diff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0)
    return { ...file, diff, additions, deletions }
  })
  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
})

/** The nearest layer left to open above (1) or below (-1); a pruned one has nothing to diff. */
function neighbour(index: number, step: 1 | -1): number | null {
  for (let at = index + step; at >= 0 && at < layers.length; at += step)
    if (!layers[at]!.pruned) return at
  return null
}

/** The first file still to read. */
const firstUnread = (index: number) => {
  const layer = layers[index]!
  return (layer.files.find((file) => !layer.viewed.includes(file.path)) ?? layer.files[0]!).path
}

/** One side and one span, as ghl stores a comment: a selection across both sides keeps its last line. */
function linesOf(path: string, selected: SelectedLineRange): Lines {
  const side = selected.endSide ?? selected.side ?? 'additions'
  if (selected.side && selected.side !== side)
    return { path, side, start: selected.end, end: selected.end }
  return {
    path,
    side,
    start: Math.min(selected.start, selected.end),
    end: Math.max(selected.start, selected.end),
  }
}

function useDocumentTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [])
  return theme
}

export default function DiffDemo() {
  const theme = useDocumentTheme()
  const [current, setCurrent] = useState(startLayer)
  const [states, setStates] = useState<LayerState[]>(() =>
    layers.map((layer) => ({
      viewed: new Set(layer.viewed),
      revealed: new Set<string>(),
      comments: layer.comments,
    })),
  )
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  const [composer, setComposer] = useState<Lines | null>(null)
  const [selection, setSelection] = useState<Lines | null>(null)
  const [active, setActive] = useState(() => firstUnread(startLayer))
  const [picker, setPicker] = useState(false)
  const [copied, setCopied] = useState(false)
  const pane = useRef<HTMLDivElement>(null)
  const nextId = useRef(0)
  const cards = useRef(new Map<string, HTMLElement>())

  const layer = layers[current]!
  const state = states[current]!
  const review = reviews[current]!
  const markdown = useMemo(() => exportComments(layer, state.comments), [layer, state.comments])
  const closePicker = useCallback(() => setPicker(false), [])

  function update(change: (state: LayerState) => LayerState) {
    setStates((all) => all.map((each, index) => (index === current ? change(each) : each)))
  }

  function openLayer(index: number) {
    setCurrent(index)
    setPicker(false)
    setComposer(null)
    setSelection(null)
    setActive(firstUnread(index))
    pane.current?.scrollTo({ top: 0 })
  }

  function show(path: string) {
    setActive(path)
    const card = cards.current.get(path)
    if (card && pane.current)
      pane.current.scrollTo({ top: card.offsetTop - 16, behavior: 'smooth' })
  }

  function toggleViewed(path: string) {
    update((each) => {
      const viewed = new Set(each.viewed)
      if (!viewed.delete(path)) viewed.add(path)
      const revealed = new Set(each.revealed)
      revealed.delete(path)
      return { ...each, viewed, revealed }
    })
  }

  function reveal(path: string) {
    update((each) => ({ ...each, revealed: new Set(each.revealed).add(path) }))
    show(path)
  }

  function addComment(body: string) {
    if (!composer) return
    const comment = { ...composer, id: String(nextId.current++), body }
    update((each) => ({ ...each, comments: [...each.comments, comment] }))
    setComposer(null)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Without clipboard access the terminal below still shows the export.
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLTextAreaElement) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const files = layer.files
    const index = files.findIndex((file) => file.path === active)
    const step = { '[': -1, ']': 1 }[event.key] as 1 | -1 | undefined
    if (step) {
      const next = neighbour(current, step)
      if (next !== null) openLayer(next)
    } else if (event.key === 's') setPicker(true)
    else if (event.key === 'j') show(files[Math.min(index + 1, files.length - 1)]!.path)
    else if (event.key === 'k') show(files[Math.max(index - 1, 0)]!.path)
    else if (event.key === 'v') toggleViewed(active)
    else if (event.key === 'c' && selection) setComposer(selection)
    else return
    event.preventDefault()
  }

  return (
    <>
      <div
        className="window demo"
        role="region"
        aria-label="A ghl review to try"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="titlebar">
          <div className="lights" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div className="capsule-anchor">
            <div className="capsule">
              <button
                type="button"
                className="layer"
                aria-haspopup="dialog"
                aria-expanded={picker}
                title="Pick a stack layer (s)"
                onClick={() => setPicker((open) => !open)}
              >
                {current + 1}/{layers.length}
              </button>
              <span>{layer.base}</span>
              <span className="faint">←</span>
              <span>{layer.branch}</span>
            </div>
            {picker && (
              <StackMenu
                layers={layers}
                current={current}
                trunk="main"
                onPick={openLayer}
                onClose={closePicker}
              />
            )}
          </div>
          <div className="actions">
            <div className="segmented optional" role="group" aria-label="Diff layout">
              {(['unified', 'split'] as const).map((style) => (
                <button
                  key={style}
                  type="button"
                  aria-pressed={diffStyle === style}
                  onClick={() => setDiffStyle(style)}
                >
                  {style === 'unified' ? 'Unified' : 'Split'}
                </button>
              ))}
            </div>
            <span className="optional">
              Comments <span className="count">{state.comments.length}</span>
            </span>
            <button type="button" className="copy" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="body">
          <nav className="tree" aria-label="Changed files">
            {layer.files.map((file) => (
              <TreeRow
                key={file.path}
                file={file}
                active={file.path === active}
                viewed={state.viewed.has(file.path)}
                onOpen={() => reveal(file.path)}
              />
            ))}
          </nav>
          <div className="pane" ref={pane}>
            {review.files.map((file) => (
              <div
                key={`${layer.branch}:${file.path}`}
                className="demo-file"
                ref={(node) => {
                  if (node) cards.current.set(file.path, node)
                  else cards.current.delete(file.path)
                }}
              >
                <DemoFileDiff
                  diff={file.diff}
                  theme={theme}
                  diffStyle={diffStyle}
                  collapsed={state.viewed.has(file.path) && !state.revealed.has(file.path)}
                  viewed={state.viewed.has(file.path)}
                  comments={state.comments.filter((comment) => comment.path === file.path)}
                  composer={composer?.path === file.path ? composer : null}
                  onToggleViewed={() => toggleViewed(file.path)}
                  onGutter={(selected) => {
                    setActive(file.path)
                    setComposer(linesOf(file.path, selected))
                  }}
                  onSelect={(selected) => {
                    setActive(file.path)
                    setSelection(selected ? linesOf(file.path, selected) : null)
                  }}
                  onSubmit={addComment}
                  onCancel={() => setComposer(null)}
                  onDelete={(id) =>
                    update((each) => ({
                      ...each,
                      comments: each.comments.filter((comment) => comment.id !== id),
                    }))
                  }
                />
              </div>
            ))}
          </div>
        </div>
        <div className="status">
          <span>Base {layer.base} · from gh stack</span>
          <span>
            {layer.files.length} files · +{review.additions} −{review.deletions}
          </span>
          <span>
            {state.viewed.size} of {layer.files.length} viewed
          </span>
        </div>
      </div>
      <div className="terminal" aria-live="polite">
        <div className="bar">
          <span className="dot"></span>
          <span className="dot"></span>
          <span className="dot"></span>~/dev/api · {layer.branch}
        </div>
        <pre>
          <span className="prompt">$</span> ghl comments{'\n'}
          {markdown
            .trimEnd()
            .split('\n')
            .map((line, index) => (
              <span key={index} className={line.startsWith('#') ? 'heading' : undefined}>
                {line}
                {'\n'}
              </span>
            ))}
        </pre>
      </div>
    </>
  )
}

function TreeRow({
  file,
  active,
  viewed,
  onOpen,
}: {
  file: DemoFile
  active: boolean
  viewed: boolean
  onOpen: () => void
}) {
  const slash = file.path.lastIndexOf('/')
  const added = file.before === null
  return (
    <>
      <div className="dir">▾ {file.path.slice(0, slash)}</div>
      <button type="button" className={active ? 'file on' : 'file'} onClick={onOpen}>
        <span className={viewed ? 'name viewed' : 'name'}>{file.path.slice(slash + 1)}</span>
        <span className={added ? 'a' : 'm'}>{added ? 'A' : 'M'}</span>
      </button>
    </>
  )
}

interface DemoFileDiffProps {
  diff: FileDiffMetadata
  theme: 'light' | 'dark'
  diffStyle: DiffStyle
  collapsed: boolean
  viewed: boolean
  comments: DemoComment[]
  composer: Lines | null
  onToggleViewed: () => void
  onGutter: (selected: SelectedLineRange) => void
  onSelect: (selected: SelectedLineRange | null) => void
  onSubmit: (body: string) => void
  onCancel: () => void
  onDelete: (id: string) => void
}

function DemoFileDiff(props: DemoFileDiffProps) {
  const { diff, theme, diffStyle, collapsed, viewed, comments, composer } = props
  // The handlers change identity on every render; the options should not.
  const latest = useRef(props)
  latest.current = props

  const options = useMemo(
    () => ({
      theme: themes,
      themeType: theme,
      diffStyle,
      collapsed,
      hunkSeparators: 'line-info' as const,
      expansionLineCount: 20,
      enableGutterUtility: true,
      onGutterUtilityClick: (selected: SelectedLineRange) => latest.current.onGutter(selected),
      enableLineSelection: true,
      onLineSelected: (selected: SelectedLineRange | null) => latest.current.onSelect(selected),
    }),
    [theme, diffStyle, collapsed],
  )

  const annotations = useMemo(() => {
    const notes: DiffLineAnnotation<Note>[] = comments.map((comment) => ({
      side: comment.side,
      lineNumber: comment.end,
      metadata: { comment },
    }))
    if (composer)
      notes.push({ side: composer.side, lineNumber: composer.end, metadata: { composer: true } })
    return notes
  }, [comments, composer])

  return (
    <FileDiff<Note>
      fileDiff={diff}
      options={options}
      lineAnnotations={annotations}
      disableWorkerPool
      renderHeaderMetadata={() => (
        <label className="viewed-toggle">
          <input
            type="checkbox"
            checked={viewed}
            onChange={() => latest.current.onToggleViewed()}
          />{' '}
          Viewed
        </label>
      )}
      renderAnnotation={({ metadata }) => {
        if (metadata && 'comment' in metadata) {
          const { comment } = metadata
          return (
            <CommentCard comment={comment} onDelete={() => latest.current.onDelete(comment.id)} />
          )
        }
        return (
          <Composer
            onSubmit={(body) => latest.current.onSubmit(body)}
            onCancel={() => latest.current.onCancel()}
          />
        )
      }}
    />
  )
}

function CommentCard({ comment, onDelete }: { comment: DemoComment; onDelete: () => void }) {
  const lines =
    comment.start === comment.end ? `L${comment.start}` : `L${comment.start}–L${comment.end}`
  return (
    <div className="demo-note">
      <div className="who">
        <b>You</b> on {lines}
        <button type="button" className="delete" aria-label="Delete the comment" onClick={onDelete}>
          ×
        </button>
      </div>
      <p>{comment.body}</p>
    </div>
  )
}

function Composer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState('')
  const submit = () => body.trim() && onSubmit(body.trim())
  return (
    <form
      className="demo-note composer"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <textarea
        autoFocus
        rows={3}
        value={body}
        placeholder="Leave a comment for your agent"
        aria-label="Comment"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
      />
      <div className="buttons">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!body.trim()}>
          Comment
        </button>
      </div>
    </form>
  )
}
