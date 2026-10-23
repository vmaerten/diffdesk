import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
import { useViewedPersistence } from './viewedPersistence.ts'

import { useTheme, type SyntaxTheme } from './theme.ts'
import CommentsPanel from './CommentsPanel.tsx'
import RepoBar from './RepoBar.tsx'
import RevisionControls, {
  revisionNote,
  type Picker,
  type RevisionProps,
} from './RevisionControls.tsx'
import { untrackedToggleable, workingTreeToggleable } from './ScopeControls.tsx'
import DesktopToolbar from './DesktopToolbar.tsx'
import ReviewFooter from './ReviewFooter.tsx'
import { DesktopSidebarFoot, DesktopSidebarHead } from './DesktopSidebar.tsx'
import StackNav from './StackNav.tsx'
import ReviewTools from './ReviewTools.tsx'
import FileTree, { type FileTreeHandle } from './FileTree.tsx'
import Resizer, { storedWidth } from './Resizer.tsx'
import { GO_POC } from './capabilities.ts'
import { asMarkdown } from '../../src/export.ts'
import type { BaseSource, DiffPayload, ServedComment } from '../../src/types.ts'
import type { SavedView, SavedViewHandle } from './savedView.ts'

/** The repo id lives in the path: /r/<repoId>. */
function repoIdFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/)
  return match?.[1] ?? null
}

/** Well under the server's idle threshold, and cheap enough to be invisible. */
const HEARTBEAT_MS = 5 * 60_000

/** A fetch that never reached anything rejects with a TypeError, not an HTTP status. */
const NOT_LISTENING = GO_POC
  ? 'ghl-go-poc is no longer listening — restart it in that repository'
  : 'ghl is no longer listening — run `ghl` again in that repository'

/** The single-letter shortcuts, by review command. */
const KEY_COMMANDS: Record<string, string> = {
  b: 'base',
  t: 'target',
  // `l` for log, which is what the list is. `c` is the comment key.
  l: 'commit',
  j: 'next-file',
  k: 'previous-file',
  r: 'refresh',
  R: 'refresh',
  c: 'comment',
  v: 'viewed',
}
const PICKERS = ['base', 'target', 'commit']

/** Shorter than the CLI's wording: this is a badge in a topbar, not a report. */
const BASE_SOURCES: Record<BaseSource, string> = {
  override: 'given on the command line',
  remembered: 'remembered',
  stack: 'from the stack',
  guessed: 'guessed',
  trunk: 'trunk',
}

export default function App({
  savedView,
  viewHandle,
  commentStore,
  onRouteChange,
  syntaxTheme: appearanceSyntax,
  codeLineHeight,
  toolbar,
  sidebarHidden = false,
  onReveal,
}: {
  savedView?: SavedView
  viewHandle?: Ref<SavedViewHandle>
  commentStore?: CommentPersistence
  /** Receives every selection URL the review writes. */
  onRouteChange?: (route: string) => void
  /** Set by the desktop app, whose appearance replaces the theme picker. */
  syntaxTheme?: SyntaxTheme
  /** Set by the desktop app when its code size changes the row height. */
  codeLineHeight?: number
  /** The desktop title bar node its review controls render into; the browser has none. */
  toolbar?: HTMLElement | null
  /** Set by the desktop app, whose title bar shows and hides the file tree. */
  sidebarHidden?: boolean
  /** Set by the desktop app: selects a file of the checkout in Finder. */
  onReveal?: (path: string) => Promise<void>
} = {}) {
  const { theme, syntaxTheme: pickedSyntax, chooseTheme } = useTheme()
  const syntaxTheme = appearanceSyntax ?? pickedSyntax
  const desktop = toolbar !== undefined
  const repoId = useMemo(repoIdFromLocation, [])
  const [data, setData] = useState<LoadedReviewDiff | null>(null)
  const loadRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(savedView?.diffStyle ?? 'unified')
  const [refreshing, setRefreshing] = useState(false)
  const [viewed, viewedPersistence] = useViewedPersistence(repoId)
  const [picking, setPicking] = useState<Picker | null>(null)
  const [selection, select] = useReviewSelection(repoId, onRouteChange)
  const { target, commit, committed, withUntracked, ignoreWhitespace, query } = selection
  const [{ comments, saving }, commentPersistence] = useCommentPersistence(repoId, commentStore)
  /** Momentary, so the button can say the clipboard actually took it. */
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(savedView?.commentsOpen ?? false)
  const panelEditor = useRef(savedView?.panelEditor ?? { editing: null, draft: '' })
  const [filesOpen, setFilesOpen] = useState(false)
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
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
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRefreshing(true)
    const receiveComments = commentPersistence.refresh()
    const receiveViewed = viewedPersistence.refresh()
    try {
      const response = await fetch(`/r/${repoId}/api/diff${selection.query}`, {
        signal: controller.signal,
      })
      const body: DiffPayload & { error?: string } = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      if (controller.signal.aborted) return
      setData({ ...body, loadId, query: selection.query, signal: controller.signal })
      receiveViewed({ ...body, query: selection.query })
      receiveComments(body.comments ?? [], body.commentBranch)
      setError(null)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof TypeError) setError(NOT_LISTENING)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }, [repoId, selection, commentPersistence, viewedPersistence])

  useEffect(() => {
    refresh()
    return () => controllerRef.current?.abort()
  }, [refresh])

  /**
   * Say we are still here, while we are still here.
   *
   * One process now serves every repository and stops on its own once nothing
   * watches it. Reading a long diff sends no request at all, so without this it
   * would stop under an open tab — the heartbeat is what makes the threshold
   * mean "no tab" rather than "no click".
   */
  useEffect(() => {
    if (GO_POC) return
    const beat = () => {
      if (document.visibilityState === 'visible') fetch('/api/health').catch(() => {})
    }
    const timer = setInterval(beat, HEARTBEAT_MS)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [])

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
      setCopyError(
        `Could not copy. Try again or check your browser's clipboard permissions. ${cause instanceof Error ? cause.message : ''}`,
      )
    }
  })

  const pickBase = useStableCallback(async (base: string | null) => {
    setPicking(null)
    try {
      await select.pickBase(base, data?.base.ref)
    } catch (cause) {
      setError(`could not save the base: ${cause instanceof Error ? cause.message : cause}`)
    }
  })

  const revealFile = useCallback((path: string) => treeRef.current?.reveal(path), [])
  const {
    view,
    entries,
    activePath,
    isComposing,
    searchOpen,
    selectFile,
    revealComment,
    canRevealComment,
    navigate,
    commentSelection,
    openSearch,
    stepSearch,
    captureView,
  } = useReviewDiff({
    savedView,
    repoId,
    data,
    diffStyle: mobile ? 'unified' : diffStyle,
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
  })
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

  /** Every review command by name: the single-letter keys and the desktop menus. */
  const runCommand = useStableCallback((command: string) => {
    switch (command) {
      case 'base':
      case 'target':
      case 'commit':
        setPicking(command)
        break
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
        if (activePath) void toggleViewed(activePath, !(activePath in viewed))
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
      case 'copy-path':
        if (activePath) void navigator.clipboard.writeText(activePath)
        break
      case 'reveal':
        if (activePath && onReveal)
          onReveal(activePath).catch((cause) =>
            setError(
              `could not reveal ${activePath}: ${cause instanceof Error ? cause.message : cause}`,
            ),
          )
        break
    }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A modal dialog owns the keyboard: the browser's comments drawer, a
      // desktop sheet. The desktop comments panel is not one, so keys still work.
      if (document.querySelector('dialog:modal')) return
      if (event.key === 'Escape' && filesOpen) {
        setFilesOpen(false)
        return
      }
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
      // And so does the composer. The guard above only covers a focused field,
      // and the pane hands focus back to its own root whenever it re-renders an
      // item — so a composer can be open with the focus nowhere near it.
      if (isComposing) return

      const name = KEY_COMMANDS[event.key]
      if (!name || (GO_POC && PICKERS.includes(name))) return
      runCommand(name)
      event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    filesOpen,
    entries.length,
    picking,
    isComposing,
    searchOpen,
    openSearch,
    stepSearch,
    runCommand,
  ])

  useEffect(() => {
    if (!desktop) return
    const listener = (event: Event) => runCommand((event as CustomEvent<string>).detail)
    window.addEventListener('desktop:command', listener)
    return () => window.removeEventListener('desktop:command', listener)
  }, [desktop, runCommand])

  const resizeSidebar = useCallback((width: number) => {
    setSidebarWidth(width)
    localStorage.setItem('ghl.sidebarWidth', String(width))
  }, [])

  const baseSource = data ? BASE_SOURCES[data.base.source] : null

  const stack = GO_POC ? null : (data?.base.stack ?? null)
  const repoName = data?.repo.path.split('/').filter(Boolean).at(-1) ?? 'Repository'
  const revision: RevisionProps = {
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
      onView={(comment) => {
        if (!desktop) setCommentsOpen(false)
        setFilesOpen(false)
        revealComment(comment)
      }}
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
      inline={desktop}
    />
  )

  return (
    <div className="app" data-repo={repoName}>
      {toolbar &&
        createPortal(
          <DesktopToolbar
            {...revision}
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
      {!desktop && (
        <header className="topbar">
          <RepoBar
            repoName={repoName}
            repoPath={data?.repo.path}
            theme={theme}
            onThemeChange={chooseTheme}
            refreshing={refreshing}
            onRefresh={refresh}
          />

          <div className="reviewbar">
            <RevisionControls {...revision} baseSource={baseSource} />

            {data && (
              <span className="stats" aria-label="Diff statistics">
                <span className="file-count">{stats.files} files</span>
                <span className="add">+{stats.additions}</span>
                <span className="del">−{stats.deletions}</span>
              </span>
            )}
          </div>

          {/* The stack is a third, conditional level: it tells a different story
            than the comparison controls above and should never disrupt them. */}
          {stack && (
            <StackNav stack={stack} headBranch={data?.head.branch} onPickTarget={pickTarget} />
          )}
        </header>
      )}

      {!desktop && (
        <ReviewTools
          filesOpen={filesOpen}
          onToggleFiles={() => setFilesOpen((value) => !value)}
          fileCount={stats.files}
          viewedCount={viewedCount}
          ignoreWhitespace={ignoreWhitespace}
          onToggleWhitespace={select.toggleWhitespace}
          diffStyle={diffStyle}
          onDiffStyleChange={setDiffStyle}
          loaded={data !== null}
          commentCount={comments.length}
          commentsOpen={commentsOpen}
          onOpenComments={() => setCommentsOpen(true)}
          copiedAll={copied === 'all'}
          onCopyAll={() => copyComments()}
        />
      )}
      <span className="visually-hidden" role="status">
        {copied ? 'Comments copied to clipboard' : ''}
      </span>
      {(!desktop || entries.length === 0) && commentsPanel}

      {copyError && !commentsOpen && (
        <div className="warning" role="alert">
          {copyError}
        </div>
      )}
      {data?.notice && <div className="warning">{data.notice}</div>}

      {data?.state?.operation && (
        <div className="warning">
          {data.state.operation} in progress — {data.state.conflicted.length} conflicted file(s).
          This diff may not mean what you expect.
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
          className={`body${filesOpen ? ' files-open' : ''}${sidebarHidden ? ' sidebar-hidden' : ''}`}
          ref={bodyRef}
          style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar" id="changed-files" aria-label="Changed files">
            <div className="sidebar-head">
              {desktop ? (
                <DesktopSidebarHead
                  fileCount={entries.length}
                  onCollapseAll={() => treeRef.current?.collapseAll()}
                  onExpandAll={() => treeRef.current?.expandAll()}
                />
              ) : (
                <>
                  <span>
                    {viewedCount > 0
                      ? `${viewedCount}/${entries.length} viewed`
                      : `${entries.length} files`}
                  </span>
                  <span className="spacer" />
                  {viewedCount > 0 && (
                    <button type="button" onClick={resetViewed} title="Unmark every file">
                      Reset
                    </button>
                  )}
                  <button type="button" onClick={() => treeRef.current?.collapseAll()}>
                    Collapse all
                  </button>
                  <button type="button" onClick={() => treeRef.current?.expandAll()}>
                    Expand all
                  </button>
                </>
              )}
            </div>
            <FileTree
              ref={treeRef}
              syntaxTheme={syntaxTheme}
              entries={entries}
              activePath={activePath}
              onSelect={(path) => {
                selectFile(path)
                setFilesOpen(false)
              }}
            />
            {desktop && (
              <DesktopSidebarFoot
                fileCount={entries.length}
                viewedCount={viewedCount}
                stats={stats}
              />
            )}
          </aside>

          {filesOpen && (
            <button
              type="button"
              className="files-backdrop"
              aria-label="Close files"
              onClick={() => setFilesOpen(false)}
            />
          )}
          <Resizer containerRef={bodyRef} onCommit={resizeSidebar} />

          {view}
          {desktop && commentsPanel}
        </div>
      )}
      {desktop && (
        <ReviewFooter
          data={data}
          baseSource={baseSource}
          note={revisionNote(data, target)}
          stack={stack}
          onPickTarget={pickTarget}
          nextPath={nextPath}
          onNext={() => navigate(1)}
        />
      )}
    </div>
  )
}
