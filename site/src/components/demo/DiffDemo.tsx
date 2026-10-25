import {
  parseDiffFromFile,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs'
import { FileDiff, useStableCallback } from '@pierre/diffs/react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { DiffSide, PullRequest } from '../../../../src/types.ts'
import CommandPalette, {
  type PaletteCommand,
  type PaletteHandle,
} from '../../../../web/src/CommandPalette.tsx'
import { commentRange } from '../../../../web/src/commentRange.ts'
import { COMMANDS, type CommandName } from '../../../../web/src/commands.ts'
import type { TreeEntry } from '../../../../web/src/FileTree.tsx'
import PullRequestPill from '../../../../web/src/PullRequestPill.tsx'
import { useSymbolCard, type TokenHandlers } from '../../../../web/src/SymbolCard.tsx'
import { exportComments, exportLines } from './comments.ts'
import {
  layers,
  startLayer,
  type DemoComment,
  type DemoFile,
  type DemoLayer,
} from './fixtures.ts'
import StackMenu from './StackMenu.tsx'
import { languages, lookUpDemoSymbol } from './symbols.ts'
import './demo.css'

type DiffStyle = 'unified' | 'split'
type Lines = { path: string; side: DiffSide; start: number; end: number }
type Note = { comment: DemoComment } | { composer: true }
/** What the reviewer changes on a layer: Diffdesk keeps it per branch. */
type LayerState = { viewed: Set<string>; revealed: Set<string>; comments: DemoComment[] }
type Line = { path: string; line: number }

/** The app's commands the demo can run; the others need a repository or a window. */
const DEMO_COMMANDS = new Set<CommandName>([
  'unified',
  'split',
  'next-file',
  'previous-file',
  'stack',
  'layer-below',
  'layer-above',
  'viewed',
  'comment',
  'copy-comments',
])

/** The review's single keys, as the app binds them. */
const KEYS: Record<string, CommandName> = {
  j: 'next-file',
  k: 'previous-file',
  v: 'viewed',
  c: 'comment',
  s: 'stack',
  '[': 'layer-below',
  ']': 'layer-above',
}

// The app's default syntax theme for each appearance.
const themes = { light: 'github-light-default', dark: 'github-dark-dimmed' } as const

const ignore = () => {}

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

/** A layer's pull request, as the app hears of it from gh. */
const pullRequestOf = ({ pr: { ahead, ...pr }, base, pruned }: DemoLayer): PullRequest => ({
  ...pr,
  url: 'https://github.com/vmaerten/ghl/pulls',
  state: pruned ? 'merged' : 'open',
  author: 'you',
  base,
  review: 'required',
  approvedBy: [],
  changesRequestedBy: [],
  requested: [],
  mergeable: 'mergeable',
  sync: { ahead, behind: 0 },
  uncommitted: false,
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

/** The lines a selection comments on, by the app's own rule. */
const linesOf = (file: { path: string; diff: FileDiffMetadata }, selected: SelectedLineRange) => ({
  path: file.path,
  ...commentRange(file.diff.hunks, selected),
})

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
  const [landing, setLanding] = useState<Line | null>(null)
  const pane = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const palette = useRef<PaletteHandle>(null)
  const cards = useRef(new Map<string, HTMLElement>())

  const layer = layers[current]!
  const state = states[current]!
  const review = reviews[current]!
  const text = useMemo(() => exportComments(layer, state.comments), [layer, state.comments])
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

  // A line outside every hunk has nowhere to scroll to.
  const canRevealLine = useStableCallback((path: string, line: number) =>
    (review.files.find((file) => file.path === path)?.diff.hunks ?? []).some(
      (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
    ),
  )

  const revealLine = useStableCallback((path: string, line: number) => {
    update((each) => ({ ...each, revealed: new Set(each.revealed).add(path) }))
    setActive(path)
    setLanding({ path, line })
  })

  const symbols = useSymbolCard({
    repoId: 'demo',
    enabled: true,
    languages,
    loadId: current,
    canReveal: canRevealLine,
    reveal: revealLine,
    onAnswer: ignore,
    theme: themes[theme],
    ask: lookUpDemoSymbol,
  })

  // The line is selected as its file renders; scrolling waits for that render.
  useEffect(() => {
    if (!landing) return
    const next = requestAnimationFrame(() => {
      const file = cards.current.get(landing.path)
      const row = file
        ?.querySelector('diffs-container')
        ?.shadowRoot?.querySelector(
          `[data-line="${landing.line}"]:not([data-line-type="change-deletion"])`,
        )
      if (row && pane.current) {
        const top = row.getBoundingClientRect().top - pane.current.getBoundingClientRect().top
        pane.current.scrollTo({
          top: pane.current.scrollTop + top - pane.current.clientHeight / 2,
          behavior: 'smooth',
        })
      }
      setLanding(null)
    })
    return () => cancelAnimationFrame(next)
  }, [landing])

  function addComment(body: string) {
    if (!composer) return
    const comment = { ...composer, id: crypto.randomUUID(), body }
    update((each) => ({ ...each, comments: [...each.comments, comment] }))
    setComposer(null)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Without clipboard access the terminal below still shows the export.
    }
  }

  /** Every command by name, from a key or the palette, as the app's runCommand. */
  function run(command: CommandName) {
    const files = layer.files
    const index = files.findIndex((file) => file.path === active)
    switch (command) {
      case 'palette':
      case 'go-to-file': {
        // Over the demo window, wherever the page is scrolled, rather than at the top of the page.
        const top = frame.current?.getBoundingClientRect().top ?? 0
        document.documentElement.style.setProperty(
          '--demo-palette-top',
          `${Math.max(16, top + 64)}px`,
        )
        setPicker(false)
        palette.current?.open(command === 'palette' ? 'commands' : 'files')
        break
      }
      case 'unified':
      case 'split':
        setDiffStyle(command)
        break
      case 'next-file':
        show(files[Math.min(index + 1, files.length - 1)]!.path)
        break
      case 'previous-file':
        show(files[Math.max(index - 1, 0)]!.path)
        break
      case 'stack':
        setPicker(true)
        break
      case 'layer-below':
      case 'layer-above': {
        const next = neighbour(current, command === 'layer-above' ? 1 : -1)
        if (next !== null) openLayer(next)
        break
      }
      case 'viewed':
        toggleViewed(active)
        break
      case 'comment':
        if (selection) setComposer(selection)
        break
      case 'copy-comments':
        void copy()
        break
    }
  }

  /** The palette leaves out what would do nothing, and checks what shows a state. */
  const paletteCommands = (): PaletteCommand[] => {
    const applies: Partial<Record<CommandName, boolean>> = {
      'layer-below': neighbour(current, -1) !== null,
      'layer-above': neighbour(current, 1) !== null,
      comment: selection !== null,
      'copy-comments': state.comments.length > 0,
    }
    const checked: Partial<Record<CommandName, boolean>> = {
      unified: diffStyle === 'unified',
      split: diffStyle === 'split',
      viewed: state.viewed.has(active),
    }
    return COMMANDS.filter(
      (command) => DEMO_COMMANDS.has(command.name) && (applies[command.name] ?? true),
    ).map((command) => ({ ...command, checked: checked[command.name] }))
  }

  const entries: TreeEntry[] = review.files.map((file) => ({
    id: file.path,
    path: file.path,
    additions: file.additions,
    deletions: file.deletions,
    binary: false,
    status: file.before === null ? 'added' : 'modified',
    viewed: state.viewed.has(file.path),
    comments: state.comments.filter((comment) => comment.path === file.path).length,
  }))

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLTextAreaElement) return
    const command =
      event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        ? ({ k: 'palette', p: 'go-to-file' } as const)[event.key as 'k' | 'p']
        : event.metaKey || event.ctrlKey || event.altKey
          ? undefined
          : KEYS[event.key]
    if (!command) return
    event.preventDefault()
    run(command)
  }

  return (
    <>
      <div
        ref={frame}
        className="window demo"
        role="region"
        aria-label="A Diffdesk review to try"
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
            <span className="optional">
              <PullRequestPill pr={pullRequestOf(layer)} workingTree place="title-bar" />
            </span>
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
                  landing={landing?.path === file.path ? landing.line : null}
                  tokens={symbols.handlers}
                  onToggleViewed={() => toggleViewed(file.path)}
                  onGutter={(selected) => {
                    setActive(file.path)
                    setComposer(linesOf(file, selected))
                  }}
                  onSelect={(selected) => {
                    setActive(file.path)
                    setSelection(selected ? linesOf(file, selected) : null)
                  }}
                  onSubmit={addComment}
                  onCancel={() => setComposer(null)}
                  onResolve={(id) =>
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
          <span className="prompt">$</span> diffdesk comments{'\n'}
          {exportLines(text).map(({ line, heading }, index) => (
            <span key={index} className={heading ? 'heading' : undefined}>
              {line}
              {'\n'}
            </span>
          ))}
        </pre>
      </div>
      <CommandPalette
        handle={palette}
        files={entries}
        commands={paletteCommands}
        onOpenFile={reveal}
        onRun={run}
      />
      {symbols.card}
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
  /** The line a definition lands on, selected as the app selects it. */
  landing: number | null
  tokens: TokenHandlers
  onToggleViewed: () => void
  onGutter: (selected: SelectedLineRange) => void
  onSelect: (selected: SelectedLineRange | null) => void
  onSubmit: (body: string) => void
  onCancel: () => void
  onResolve: (id: string) => void
}

type TokenEvent = Parameters<TokenHandlers['onTokenEnter']>[0]
const context = (diff: FileDiffMetadata) => ({ item: { type: 'diff', fileDiff: diff } })

function DemoFileDiff(props: DemoFileDiffProps) {
  const { diff, theme, diffStyle, collapsed, viewed, comments, composer, landing } = props
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
      // The symbol card asks which file a token is in, as the app's CodeView tells it.
      onTokenEnter: (token: TokenEvent, event: PointerEvent) =>
        latest.current.tokens.onTokenEnter(token, event, context(latest.current.diff)),
      onTokenLeave: (token: TokenEvent, event: PointerEvent) =>
        latest.current.tokens.onTokenLeave(token, event, context(latest.current.diff)),
      onTokenClick: (token: TokenEvent, event: MouseEvent) =>
        latest.current.tokens.onTokenClick(token, event, context(latest.current.diff)),
    }),
    [theme, diffStyle, collapsed],
  )

  const selectedLines = useMemo(
    () =>
      landing === null ? undefined : { start: landing, end: landing, side: 'additions' as const },
    [landing],
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
      selectedLines={selectedLines}
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
            <CommentCard comment={comment} onResolve={() => latest.current.onResolve(comment.id)} />
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

function CommentCard({ comment, onResolve }: { comment: DemoComment; onResolve: () => void }) {
  const lines =
    comment.start === comment.end ? `L${comment.start}` : `L${comment.start}–L${comment.end}`
  return (
    <div className="demo-note">
      <div className="who">
        <b>You</b> on {lines}
        <button
          type="button"
          className="resolve"
          title="Close this comment and keep it"
          onClick={onResolve}
        >
          Resolve
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
