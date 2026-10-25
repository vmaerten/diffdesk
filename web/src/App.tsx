import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { useStableCallback } from '@pierre/diffs/react'
import { useReviewDiff, type LoadedReviewDiff } from './useReviewDiff.tsx'
import { useReviewSelection } from './reviewSelection.ts'
import {
  useCommentPersistence,
  type CommentPersistence,
  type CommentSubmission,
} from './commentPersistence.ts'
import { useViewedPersistence, type ViewedPersistence } from './viewedPersistence.ts'

import type { SyntaxTheme } from './theme.ts'
import CommentsPanel from './CommentsPanel.tsx'
import { comparisonNote, type Picker, type ComparisonProps } from './ComparisonControls.tsx'
import { untrackedToggleable, workingTreeToggleable } from './ScopeControls.tsx'
import DesktopToolbar from './DesktopToolbar.tsx'
import ReviewFooter from './ReviewFooter.tsx'
import { layerTarget, neighbourLayer } from './StackPicker.tsx'
import { DesktopSidebarFoot, DesktopSidebarHead } from './DesktopSidebar.tsx'
import FileTree, { type FileTreeHandle } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import {
  commandOf,
  fileCommandOf,
  type FileCommand,
  type ReviewCommand,
  type WindowCommand,
} from './commands.ts'
import { contextFile } from './fileMenu.ts'
import { languagesOf, useLanguageStatus } from './codeIntelligence.ts'
import { useSymbolCard } from './SymbolCard.tsx'
import type { LanguageStatus } from '../../src/types.ts'
import { asMarkdown } from '../../src/export.ts'
import type { BaseSource, DiffPayload, ServedComment } from '../../src/types.ts'
import type { SavedView, SavedViewHandle } from './savedView.ts'

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

const NO_LANGUAGES: LanguageStatus[] = []

/** Review commands, by their single-letter key. */
const KEY_COMMANDS: Record<string, ReviewCommand> = {
  b: 'base',
  t: 'target',
  // `l` for log, which is what the list is. `c` is the comment key.
  l: 'commit',
  j: 'next-file',
  k: 'previous-file',
  s: 'stack',
  '[': 'layer-below',
  ']': 'layer-above',
  r: 'refresh',
  R: 'refresh',
  c: 'comment',
  v: 'viewed',
}

/** Shorter than the CLI's wording: this is a badge in a topbar, not a report. */
const BASE_SOURCES: Record<BaseSource, string> = {
  override: 'chosen for this review',
  stack: 'from the stack',
  guessed: 'guessed',
  trunk: 'trunk',
}

export default function App({
  savedView,
  viewHandle,
  commentStore,
  viewedStore,
  onRouteChange,
  syntaxTheme,
  codeLineHeight,
  toolbar,
  sidebarHidden,
  onReveal,
  onFileMenu,
  languageRevision = null,
}: {
  savedView?: SavedView
  viewHandle?: Ref<SavedViewHandle>
  commentStore?: CommentPersistence
  viewedStore?: ViewedPersistence
  /** Receives every selection URL the review writes. */
  onRouteChange?: (route: string) => void
  syntaxTheme: SyntaxTheme
  /** Follows the code size, which changes the row height. */
  codeLineHeight?: number
  /** The title bar node the review controls render into, once mounted. */
  toolbar: HTMLElement | null
  /** The title bar shows and hides the file tree. */
  sidebarHidden: boolean
  /** Selects a file of the checkout in Finder. */
  onReveal?: (path: string) => Promise<void>
  /** Opens the native context menu of a file at x, y; without it, the default menu stays. */
  onFileMenu?: (path: string, x: number, y: number, viewed: boolean) => Promise<void>
  /** Changes when the review server has new code intelligence settings; null while it is off. */
  languageRevision?: number | null
}) {
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState<LoadedReviewDiff | null>(null)
  const loadRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  // The shown comparison's context requests live until it is replaced, not
  // until the next refresh starts: a failed refresh leaves it on screen.
  const shownRef = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [languageStatus, refreshLanguages] = useLanguageStatus(repoId, languageRevision)
  // A refreshed review may find a server stopped, or started, meanwhile.
  const shownLoad = data?.loadId
  useEffect(() => {
    if (shownLoad !== undefined) refreshLanguages()
  }, [shownLoad, refreshLanguages])
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(savedView?.diffStyle ?? 'unified')
  const [viewed, viewedPersistence] = useViewedPersistence(repoId, viewedStore)
  const [picking, setPicking] = useState<Picker | null>(null)
  const [selection, select] = useReviewSelection(onRouteChange)
  const { target, commit, committed, withUntracked, ignoreWhitespace, query } = selection
  const [{ comments, saving }, commentPersistence] = useCommentPersistence(repoId, commentStore)
  /** Momentary, so the button can say the clipboard actually took it. */
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(savedView?.commentsOpen ?? false)
  const panelEditor = useRef(savedView?.panelEditor ?? { editing: null, draft: '' })
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )
  /** Folding and revealing live inside the tree, which owns that state. */
  const treeRef = useRef<FileTreeHandle>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState(storedWidth)

  /**
   * The single refresh path.
   *
   * Everything that reloads the diff goes through here — the R key now, a
   * watcher later, which is what keeps that a ten-line change.
   */
  const refresh = useCallback(async () => {
    if (!repoId) {
      setError('no repository in the URL (expected /r/<repoId>)')
      return
    }
    const loadId = ++loadRef.current
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const receiveComments = commentPersistence.refresh()
    const receiveViewed = viewedPersistence.refresh()
    try {
      const response = await fetch(`/r/${repoId}/api/diff${selection.query}`, {
        signal: controller.signal,
      })
      const body: DiffPayload & { error?: string } = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (controller.signal.aborted) return
      shownRef.current?.abort()
      const shown = new AbortController()
      shownRef.current = shown
      setData({ ...body, loadId, query: selection.query, signal: shown.signal })
      receiveViewed({ ...body, query: selection.query })
      receiveComments(body.comments ?? [], body.commentBranch)
      setError(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [repoId, selection, commentPersistence, viewedPersistence])

  useEffect(() => {
    refresh()
    return () => requestRef.current?.abort()
  }, [refresh])
  useEffect(() => () => shownRef.current?.abort(), [])

  const pickTarget = useCallback(
    (ref: string | null) => {
      setPicking(null)
      select.pickTarget(ref)
    },
    [select],
  )
  const pickCommit = useCallback(
    (sha: string | null) => {
      setPicking(null)
      select.pickCommit(sha)
    },
    [select],
  )
  const { toggleCommitted, toggleUntracked } = select

  const stats = data?.totals ?? { files: 0, additions: 0, deletions: 0 }
  const viewedCount = Object.keys(viewed).length

  const toggleViewed = useCallback(
    async (path: string, next: boolean) => {
      try {
        await viewedPersistence.set(path, next)
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        setError(`could not save viewed state: ${detail}`)
      }
    },
    [viewedPersistence],
  )

  const resetViewed = useCallback(async () => {
    try {
      await viewedPersistence.reset()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      setError(`could not reset viewed state: ${detail}`)
    }
  }, [viewedPersistence])

  const submitComment = useStableCallback((draft: CommentSubmission) => {
    if (data) void commentPersistence.submit(draft, data)
  })

  const deleteComment = useStableCallback(async (id: string) => {
    try {
      await commentPersistence.remove(id)
    } catch (cause) {
      setError(`could not delete the comment: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  /**
   * Put the whole review on the clipboard, as markdown.
   *
   * `asMarkdown` is the CLI's too, so the button and `ghl comments` cannot
   * produce different text for the same review. Failing to reach the clipboard is
   * said out loud: the point of the gesture is that the text left the page.
   */
  const copyComments = useStableCallback(async (comment?: ServedComment) => {
    if (!data) return
    setCopyError(null)
    setCopied(null)
    try {
      await navigator.clipboard.writeText(
        asMarkdown(comment ? [comment] : comments, { range: data.range }),
      )
      setCopied(comment?.id ?? 'all')
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(null), 2000)
    } catch (cause) {
      setCopyError(`Could not copy. ${cause instanceof Error ? cause.message : ''}`)
    }
  })

  const pickBase = useStableCallback((base: string | null) => {
    setPicking(null)
    if (base !== data?.base.ref) select.pickBase(base)
  })

  const revealFile = useCallback((path: string) => treeRef.current?.reveal(path), [])
  // The card reveals definitions through the diff, which needs the card's handlers first.
  const lines = useRef<{
    can: (path: string, line: number) => boolean
    reveal: (path: string, line: number) => void
  }>({ can: () => false, reveal: () => {} })
  const canRevealDefinition = useCallback(
    (path: string, line: number) => lines.current.can(path, line),
    [],
  )
  const revealDefinition = useCallback(
    (path: string, line: number) => lines.current.reveal(path, line),
    [],
  )
  const symbols = useSymbolCard({
    repoId,
    enabled: languageRevision !== null && data?.target.workingTree === true,
    languages: languageStatus?.languages ?? NO_LANGUAGES,
    loadId: data?.loadId,
    canReveal: canRevealDefinition,
    reveal: revealDefinition,
    onAnswer: refreshLanguages,
    theme: syntaxTheme,
  })
  const {
    view,
    entries,
    activePath,
    searchOpen,
    selectFile,
    revealComment,
    canRevealComment,
    revealLine,
    canRevealLine,
    navigate,
    commentSelection,
    openSearch,
    stepSearch,
    captureView,
  } = useReviewDiff({
    savedView,
    repoId,
    data,
    diffStyle,
    syntaxTheme,
    lineHeight: codeLineHeight,
    viewed,
    comments,
    copied,
    onCopy: copyComments,
    saving,
    onViewedChange: toggleViewed,
    onSubmit: submitComment,
    onDelete: deleteComment,
    onRetry: (comment) => {
      void commentPersistence.retry(comment.id)
    },
    onRevealFile: revealFile,
    tokenHandlers: symbols.handlers,
  })
  lines.current = {
    can: (path, line) => canRevealLine(path, 'additions', line),
    reveal: revealLine,
  }
  useImperativeHandle(
    viewHandle,
    () => ({
      capture: () => ({
        version: 1,
        diffStyle,
        commentsOpen,
        panelEditor: { ...panelEditor.current },
        ...captureView(),
      }),
    }),
    [diffStyle, commentsOpen, captureView],
  )

  const runFileCommand = useStableCallback((command: FileCommand, path: string) => {
    switch (command) {
      case 'viewed':
        void toggleViewed(path, !(path in viewed))
        break
      case 'copy-path':
        navigator.clipboard
          .writeText(path)
          .catch((cause) =>
            setCopyError(`Could not copy ${path}. ${cause instanceof Error ? cause.message : ''}`),
          )
        break
      case 'reveal':
        onReveal?.(path).catch((cause) =>
          setError(`could not reveal ${path}: ${cause instanceof Error ? cause.message : cause}`),
        )
        break
    }
  })

  const openFileMenu = useStableCallback((event: MouseEvent) => {
    const path = onFileMenu && contextFile(event.nativeEvent)
    if (!path) return
    // The native menu replaces the page's default one.
    event.preventDefault()
    event.stopPropagation()
    onFileMenu(path, event.clientX, event.clientY, path in viewed).catch((cause) =>
      setError(`could not open the file menu: ${cause instanceof Error ? cause.message : cause}`),
    )
  })

  /** Every review command by name: the single-letter keys and the desktop menus. */
  const runCommand = useStableCallback((command: ReviewCommand | WindowCommand) => {
    switch (command) {
      case 'base':
      case 'target':
      case 'commit':
        setPicking(command)
        break
      case 'stack':
        if (data?.base.stack) setPicking(command)
        break
      case 'layer-below':
      case 'layer-above': {
        const stack = data?.base.stack
        const layer = stack && neighbourLayer(stack, command === 'layer-above' ? 1 : -1)
        if (layer) pickTarget(layerTarget(layer, data?.head.branch))
        break
      }
      case 'next-file':
        navigate(1)
        break
      case 'previous-file':
        navigate(-1)
        break
      case 'refresh':
        void refresh()
        break
      case 'comment':
        commentSelection()
        break
      case 'viewed':
      case 'copy-path':
      case 'reveal':
        if (activePath) runFileCommand(command, activePath)
        break
      case 'unified':
      case 'split':
        setDiffStyle(command)
        break
      case 'working-tree':
        if (workingTreeToggleable(data, target, commit)) toggleCommitted()
        break
      case 'untracked':
        if (untrackedToggleable(data)) toggleUntracked()
        break
      case 'whitespace':
        select.toggleWhitespace()
        break
      case 'comments':
        setCommentsOpen((open) => !open)
        break
      case 'copy-comments':
        if (comments.length > 0) void copyComments()
        break
      case 'reset-viewed':
        void resetViewed()
        break
    }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal sheet owns the keyboard. The comments panel is not one, so keys still work.
      if (document.querySelector('dialog:modal')) return
      const key = event.key.toLocaleLowerCase()
      const command = event.metaKey || event.ctrlKey

      if (entries.length > 0 && command && !event.altKey && key === 'f') {
        event.preventDefault()
        setPicking(null)
        openSearch()
        return
      }
      if (searchOpen && ((command && !event.altKey && key === 'g') || event.key === 'F3')) {
        event.preventDefault()
        stepSearch(event.shiftKey ? -1 : 1)
        return
      }

      // Never steal keys from an input or from a browser shortcut.
      // Not `target`: that name already means the revision under review.
      const focused = event.target
      const tag = focused instanceof HTMLElement ? focused.tagName : null
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (focused instanceof HTMLElement && focused.isContentEditable) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      if (picking) return // the picker owns the keyboard while open
      // And so does a composer on screen. The guard above only covers a focused
      // field, and the pane hands focus back to its own root whenever it
      // re-renders an item — so a composer can be open with the focus nowhere
      // near it. One whose line left the comparison renders nowhere, and must
      // not hold the keys.
      if (document.querySelector('.comment-composer')) return

      const name = KEY_COMMANDS[event.key]
      if (!name) return
      runCommand(name)
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [entries.length, picking, searchOpen, openSearch, stepSearch, runCommand])

  useEffect(() => {
    const listener = (event: Event) => runCommand(commandOf(event))
    window.addEventListener('desktop:command', listener)
    return () => window.removeEventListener('desktop:command', listener)
  }, [runCommand])

  useEffect(() => {
    const listener = (event: Event) => {
      const { command, path } = fileCommandOf(event)
      runFileCommand(command, path)
    }
    window.addEventListener('desktop:file-command', listener)
    return () => window.removeEventListener('desktop:file-command', listener)
  }, [runFileCommand])

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  const baseSource = data ? BASE_SOURCES[data.base.source] : null

  const repoName = data?.repo.path.split('/').filter(Boolean).at(-1) ?? 'Repository'
  const comparison: ComparisonProps = {
    repoId,
    data,
    query,
    target,
    commit,
    committed,
    withUntracked,
    picking,
    onPickingChange: setPicking,
    onPickBase: pickBase,
    onPickTarget: pickTarget,
    onPickCommit: pickCommit,
    onToggleCommitted: toggleCommitted,
    onToggleUntracked: toggleUntracked,
  }
  const nextPath =
    entries[entries.findIndex((entry) => entry.path === activePath) + 1]?.path ?? null

  const footer = (
    <ReviewFooter
      data={data}
      baseSource={baseSource}
      note={comparisonNote(data, target)}
      nextPath={nextPath}
      onNext={() => navigate(1)}
      languages={
        languageRevision === null || !data
          ? null
          : languagesOf(
              languageStatus,
              data.files.map((file) => file.path),
            )
      }
    />
  )
  const commentsPanel = (
    <CommentsPanel
      savedEditor={panelEditor}
      open={commentsOpen}
      comments={comments}
      currentRange={data?.range ?? ''}
      saving={saving}
      copied={copied}
      copyError={copyError}
      onClose={() => setCommentsOpen(false)}
      onCopy={copyComments}
      canView={canRevealComment}
      onView={revealComment}
      onUpdate={(comment, body) =>
        submitComment({
          path: comment.path,
          side: comment.side,
          start: comment.start,
          end: comment.end,
          editing: comment.id,
          body,
        })
      }
      onDelete={deleteComment}
      onRetry={(comment) => {
        void commentPersistence.retry(comment.id)
      }}
    />
  )

  return (
    <div className="app" data-repo={repoName} onContextMenu={openFileMenu}>
      {toolbar &&
        createPortal(
          <DesktopToolbar
            {...comparison}
            ignoreWhitespace={ignoreWhitespace}
            onToggleWhitespace={select.toggleWhitespace}
            diffStyle={diffStyle}
            onDiffStyleChange={setDiffStyle}
            commentCount={comments.length}
            commentsOpen={commentsOpen}
            onToggleComments={() => setCommentsOpen((open) => !open)}
            copiedAll={copied === 'all'}
            onCopyAll={() => copyComments()}
          />,
          toolbar,
        )}
      {symbols.card}
      <span className="visually-hidden" role="status">
        {copied ? 'Comments copied to clipboard' : ''}
      </span>
      {entries.length === 0 && commentsPanel}

      {copyError && !commentsOpen && (
        <div className="warning" role="alert">
          {copyError}
        </div>
      )}
      {data?.notice && <div className="warning">{data.notice}</div>}

      {data?.state?.operation && (
        <div className="warning">
          {data.state.operation} in progress
          {data.state.conflicted.length > 0 &&
            ` — ${data.state.conflicted.length} conflicted file(s)`}
          . This diff may not mean what you expect.
        </div>
      )}

      {error && <p className="message">{error}</p>}

      {!error && data && entries.length === 0 && (
        <p className="message">
          {new URLSearchParams(data.query).get('w') === '1' ? (
            <>
              Nothing to show with whitespace changes hidden. Turn off Ignore whitespace to see the
              full diff.
            </>
          ) : data.commit ? (
            <>
              Nothing to show — <code>{data.commit.short}</code> changes no file.
            </>
          ) : committed ? (
            // Not "matches the base": the work may well be there, uncommitted,
            // and it is this button that is hiding it.
            <>
              Nothing to show — nothing is committed above <code>{data.base.ref}</code>, and the
              working tree is excluded.
            </>
          ) : data.untracked.length > 0 ? (
            // Not "matches the base" either: the files are there, and the button
            // carrying that count is what keeps them out.
            <>
              Nothing to show — nothing but {data.untracked.length} untracked file(s), which the
              Untracked checkbox brings in.
            </>
          ) : data.comparison.before === (data.comparison.after ?? data.head.sha) &&
            data.base.sha !== data.comparison.before ? (
            // The base already holds every commit of the target, which a base
            // picked by mistake does: say so, and offer the way back.
            <>
              Nothing to show — <code>{data.target.ref}</code> is already part of the base,{' '}
              <code>{data.base.ref}</code>.{' '}
              {data.base.source === 'override' && (
                <button type="button" className="link" onClick={() => pickBase(null)}>
                  Use the automatic base
                </button>
              )}
            </>
          ) : (
            <>
              Nothing to show — <code>{data.head.branch}</code> matches <code>{data.base.ref}</code>
              .
            </>
          )}
        </p>
      )}

      {entries.length > 0 && (
        <div
          className={`body${sidebarHidden ? ' sidebar-hidden' : ''}`}
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar" id="changed-files" aria-label="Changed files">
            <div className="sidebar-head">
              <DesktopSidebarHead
                fileCount={entries.length}
                onCollapseAll={() => treeRef.current?.collapseAll()}
                onExpandAll={() => treeRef.current?.expandAll()}
              />
            </div>
            <FileTree
              ref={treeRef}
              syntaxTheme={syntaxTheme}
              entries={entries}
              activePath={activePath}
              onSelect={selectFile}
            />
            <DesktopSidebarFoot
              fileCount={entries.length}
              viewedCount={viewedCount}
              stats={stats}
            />
          </aside>

          <Resizer containerRef={bodyRef} onCommit={resizeSidebar} />

          {/* The status bar belongs to the code: the sidebar and the comments
            panel run the full height beside it. */}
          <div className="review-main">
            {view}
            {footer}
          </div>
          {commentsPanel}
        </div>
      )}
      {entries.length === 0 && footer}
    </div>
  )
}
