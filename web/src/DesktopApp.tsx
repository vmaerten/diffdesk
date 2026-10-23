import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import App from './App.tsx'
import Icon from './Icon.tsx'
import { releaseUrl } from './reviewSelection.ts'
import { sameCapacity, splitTabs, tabSizes } from './tabOverflow.ts'
import { useAppearance } from './appearance.ts'
import { commandOf } from './commands.ts'
import SettingsSheet from './SettingsSheet.tsx'
import ShortcutsSheet from './ShortcutsSheet.tsx'
import {
  codeFontFamily,
  codeLineHeight,
  DEFAULT_SETTINGS,
  readSettings,
  type DesktopSettings,
} from './desktopSettings.ts'
import type { SavedView, SavedViewHandle } from './savedView.ts'
import {
  createRepositoryCommentPersistence,
  type CommentPersistence,
} from './commentPersistence.ts'
import desktopStyles from './desktop.css?inline'

interface ReviewTab {
  id: string
  name: string
  /** The checkout, home-relative: ~/dev/repo. */
  path: string
  route: string
  view?: SavedView
}
interface Tabs {
  revision: number
  active: string
  tabs: ReviewTab[]
}
interface DesktopAPI {
  Tabs(): Promise<Tabs>
  ActivateTab(id: string): Promise<Tabs>
  CloseTab(id: string): Promise<Tabs>
  UpdateTabURL(id: string, route: string): Promise<Tabs>
  OpenRepository(): Promise<void>
  SaveTabView(id: string, raw: string): Promise<void>
  Settings(): Promise<string>
  SaveSettings(raw: string): Promise<void>
  RevealInFinder(tabID: string, path: string): Promise<void>
}
declare global {
  interface Window {
    go?: { main: { desktopApp: DesktopAPI } }
    runtime?: {
      EventsOn(name: string, callback: (state: Tabs) => void): () => void
      WindowSetTitle(title: string): void
    }
  }
}
const EMPTY: Tabs = { revision: 0, active: '', tabs: [] }
const Review = memo(App)

export default function DesktopApp() {
  const [state, setState] = useState(EMPTY)
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      return localStorage.getItem('ghl.sidebarHidden') === '1'
    } catch {
      return false
    }
  })
  const toggleSidebar = useStableCallback(() => {
    setSidebarHidden((hidden) => {
      try {
        localStorage.setItem('ghl.sidebarHidden', hidden ? '0' : '1')
      } catch {
        // The choice still holds for this session.
      }
      return !hidden
    })
  })
  const syntaxTheme = useAppearance(settings ?? DEFAULT_SETTINGS)
  const latest = useRef(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const accept = useRef<(state: Tabs) => void>(() => {})
  const apply = useStableCallback((reply: Promise<Tabs> | undefined) => {
    void reply?.then(accept.current).catch((cause) => setError(String(cause)))
  })
  const views = useRef(new Map<string, SavedView>())
  // Writes and retries outlive the mounted review, and are released when its tab closes.
  const commentStores = useRef(new Map<string, CommentPersistence>())
  const viewHandle = useRef<SavedViewHandle>(null)
  useEffect(() => {
    const api = window.go?.main.desktopApp
    const runtime = window.runtime
    if (!api || !runtime) {
      setError('Desktop runtime is unavailable')
      return
    }
    let disposed = false
    const save = async () => {
      const id = latest.current.active
      if (
        !id ||
        document.querySelector('.desktop-review')?.getAttribute('data-active-tab') !== id ||
        !viewHandle.current
      )
        return
      const view = viewHandle.current.capture()
      views.current.set(id, view)
      await api.SaveTabView(id, JSON.stringify(view))
    }
    const update = (next: Tabs) => {
      if (disposed || next.revision < latest.current.revision) return
      const previous = latest.current
      if (
        previous.active &&
        previous.active !== next.active &&
        next.tabs.some((tab) => tab.id === previous.active)
      )
        void save().catch((cause) => setError(String(cause)))
      for (const id of views.current.keys())
        if (!next.tabs.some((tab) => tab.id === id)) views.current.delete(id)
      for (const id of commentStores.current.keys())
        if (!next.tabs.some((tab) => tab.id === id)) commentStores.current.delete(id)
      latest.current = next
      const active = next.tabs.find((tab) => tab.id === next.active)
      if (active && !commentStores.current.has(active.id)) {
        const repoId = new URL(active.route, location.href).pathname.split('/')[2] ?? null
        commentStores.current.set(active.id, createRepositoryCommentPersistence(repoId))
      }
      if (active && !views.current.has(active.id))
        views.current.set(
          active.id,
          active.view?.version === 1
            ? active.view
            : {
                version: 1,
                diffStyle: 'unified',
                commentsOpen: false,
                panelEditor: { editing: null, draft: '' },
                scrollTop: 0,
                composer: null,
                drafts: [],
                expansions: [],
              },
        )
      runtime.WindowSetTitle(active ? `ghl — ${active.name}` : 'ghl')
      // The outgoing review stays mounted until the next render, so detach it before
      // seeding the URL that the next App reads at mount.
      if (previous.active !== next.active) {
        releaseUrl()
        history.replaceState(null, '', active?.route ?? '/')
      }
      setState(next)
    }
    accept.current = update
    const unsubscribe = runtime.EventsOn('desktop:tabs', update)
    apply(api.Tabs())
    const reload = () => {
      void save()
        .then(() => location.reload())
        .catch((cause) => setError(String(cause)))
    }
    const closeActive = () => apply(api.CloseTab(latest.current.active))
    const cycle = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.key !== 'Tab' || latest.current.tabs.length < 2) return
      event.preventDefault()
      const tabs = latest.current.tabs
      const index = tabs.findIndex((tab) => tab.id === latest.current.active)
      const next = tabs[(index + tabs.length + (event.shiftKey ? -1 : 1)) % tabs.length]
      if (next) apply(api.ActivateTab(next.id))
    }
    // The window's menu commands; App takes the review's from the same event.
    const runCommand = (event: Event) => {
      const command = commandOf(event)
      if (command === 'reload') reload()
      else if (command === 'close-tab') closeActive()
      else if (command === 'settings') setSettingsOpen(true)
      else if (command === 'shortcuts') setShortcutsOpen(true)
      else if (command === 'sidebar') toggleSidebar()
    }
    window.addEventListener('desktop:command', runCommand)
    window.addEventListener('keydown', cycle)
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('desktop:command', runCommand)
      window.removeEventListener('keydown', cycle)
    }
  }, [apply, toggleSidebar])
  useEffect(() => {
    window.go?.main.desktopApp
      .Settings()
      .then((raw) => setSettings(readSettings(raw)))
      .catch((cause) => {
        setError(String(cause))
        setSettings(DEFAULT_SETTINGS)
      })
  }, [])
  // Each change applies to the latest settings: two controls used before a
  // render must not undo each other.
  const settingsChanged = useRef(false)
  const changeSettings = useStableCallback((patch: Partial<DesktopSettings>) => {
    settingsChanged.current = true
    setSettings((current) => current && { ...current, ...patch })
  })
  // Saved once changes settle: typing a font name would otherwise write, and
  // race, on every keystroke. Loading them is not a change.
  useEffect(() => {
    if (!settings || !settingsChanged.current) return
    const timer = setTimeout(() => {
      void window.go?.main.desktopApp
        .SaveSettings(JSON.stringify(settings))
        .catch((cause) => setError(String(cause)))
    }, 300)
    return () => clearTimeout(timer)
  }, [settings])
  const tabsArea = useRef<HTMLDivElement>(null)
  const [tabsWidth, setTabsWidth] = useState(Infinity)
  useEffect(() => {
    const area = tabsArea.current
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry!.contentRect.width
      setTabsWidth((current) => (sameCapacity(current, width) ? current : width))
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])
  const focusTab = useRef<string | null>(null)
  useEffect(() => {
    if (!focusTab.current || focusTab.current !== state.active) return
    document.getElementById(`review-tab-${state.active}`)?.focus()
    focusTab.current = null
  }, [state.active])
  const reveal = useStableCallback(async (path: string) =>
    window.go?.main.desktopApp.RevealInFinder(latest.current.active, path),
  )
  const routeChanged = useStableCallback((route: string) => {
    const active = latest.current.tabs.find((tab) => tab.id === latest.current.active)
    if (active && active.route !== route)
      apply(window.go?.main.desktopApp.UpdateTabURL(active.id, route))
  })
  const activate = (id: string) => apply(window.go?.main.desktopApp.ActivateTab(id))
  const close = (id: string) => apply(window.go?.main.desktopApp.CloseTab(id))
  const open = () => {
    void window.go?.main.desktopApp.OpenRepository().catch((cause) => setError(String(cause)))
  }
  const active = state.tabs.find((tab) => tab.id === state.active)
  const layout = splitTabs(
    state.tabs.length,
    state.tabs.findIndex((tab) => tab.id === state.active),
    tabsWidth,
  )
  return (
    <div
      className="desktop-shell"
      style={
        settings
          ? ({
              '--code-font': codeFontFamily(settings.codeFont),
              '--code-size': `${settings.codeSize}px`,
              '--code-line-height': `${codeLineHeight(settings.codeSize)}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <style>{desktopStyles}</style>
      <header className="desktop-titlebar">
        <button
          className="titlebar-button"
          aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
          title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar (⌃⌘S)`}
          aria-pressed={!sidebarHidden}
          disabled={!active}
          onClick={toggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
        <button
          className="titlebar-button"
          aria-label="Open repository"
          title="Open repository (⌘O)"
          onClick={open}
        >
          <Icon name="plus" />
        </button>
        <div className="desktop-tabs-area" ref={tabsArea} style={tabSizes}>
          <div
            role="tablist"
            aria-label="Open reviews"
            className={`desktop-tabs${state.tabs.length > 1 ? ' multi' : ''}`}
          >
            {layout.shown.map((index) => {
              const tab = state.tabs[index]!
              const query = new URL(tab.route, location.href).searchParams
              const comparison = `${query.get('base') ?? 'Auto base'} → ${query.get('target') ?? 'Working tree'}`
              const cut = tab.path.lastIndexOf('/') + 1
              return (
                <div
                  className={`desktop-tab ${tab.id === state.active ? 'active' : ''}`}
                  key={tab.id}
                >
                  <button
                    role="tab"
                    id={`review-tab-${tab.id}`}
                    aria-selected={tab.id === state.active}
                    aria-controls="desktop-review"
                    tabIndex={tab.id === state.active ? 0 : -1}
                    title={`${tab.path || tab.name} · ${comparison}`}
                    onClick={() => activate(tab.id)}
                    onKeyDown={(event) => {
                      let next: number | undefined
                      if (event.key === 'ArrowRight') next = (index + 1) % state.tabs.length
                      if (event.key === 'ArrowLeft')
                        next = (index + state.tabs.length - 1) % state.tabs.length
                      if (event.key === 'Home') next = 0
                      if (event.key === 'End') next = state.tabs.length - 1
                      if (next === undefined) return
                      event.preventDefault()
                      event.stopPropagation()
                      const nextTab = state.tabs[next]
                      if (!nextTab) return
                      // It may sit in the » menu until the activation renders it.
                      focusTab.current = nextTab.id
                      activate(nextTab.id)
                    }}
                  >
                    {/* One review reads as its checkout; several, by name. */}
                    {state.tabs.length === 1 && tab.path ? (
                      <>
                        <span className="tab-dir">{tab.path.slice(0, cut)}</span>
                        <span className="tab-name">{tab.path.slice(cut)}</span>
                      </>
                    ) : (
                      <span className="tab-name">{tab.name}</span>
                    )}
                  </button>
                  <button
                    className="desktop-tab-close"
                    aria-label={`Close ${tab.name}`}
                    title="Close review (⌘W)"
                    onClick={() => close(tab.id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              )
            })}
          </div>
          {layout.hidden.length > 0 && (
            <label className="titlebar-more" title="More reviews">
              <Icon name="more" />
              <select
                aria-label="More reviews"
                value=""
                onChange={(event) => activate(event.target.value)}
              >
                <option value="" disabled>
                  More reviews
                </option>
                {layout.hidden.map((index) => {
                  const tab = state.tabs[index]!
                  return (
                    <option key={tab.id} value={tab.id}>
                      {tab.name}
                    </option>
                  )
                })}
              </select>
            </label>
          )}
        </div>
        <div className="titlebar-review" ref={setToolbar} />
      </header>
      {error ? (
        <p role="alert" className="desktop-error">
          {error}
          <button onClick={() => setError(null)}>Dismiss</button>
        </p>
      ) : null}
      {active ? (
        <div
          role="tabpanel"
          id="desktop-review"
          className="desktop-review"
          aria-labelledby={`review-tab-${active.id}`}
          data-active-tab={active.id}
        >
          {settings && (
            <Review
              key={active.id}
              savedView={views.current.get(active.id)}
              viewHandle={viewHandle}
              commentStore={commentStores.current.get(active.id)}
              onRouteChange={routeChanged}
              syntaxTheme={syntaxTheme}
              codeLineHeight={codeLineHeight(settings.codeSize)}
              toolbar={toolbar}
              sidebarHidden={sidebarHidden}
              onReveal={reveal}
            />
          )}
        </div>
      ) : (
        <div className="desktop-empty">
          <h1>ghl</h1>
          <p>Open a repository to start a review.</p>
          <button className="button primary" onClick={open}>
            Open Repository… <kbd>⌘O</kbd>
          </button>
        </div>
      )}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {settings && (
        <SettingsSheet
          open={settingsOpen}
          settings={settings}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
