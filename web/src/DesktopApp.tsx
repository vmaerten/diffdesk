import { memo, useEffect, useRef, useState } from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import App from './App.tsx'
import Icon from './Icon.tsx'
import { releaseUrl } from './reviewSelection.ts'
// Inlined so the browser build, which tree-shakes this module, carries no desktop CSS.
import desktopStyles from './desktop.css?inline'

interface ReviewTab {
  id: string
  name: string
  route: string
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
  const latest = useRef(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const accept = useRef<(state: Tabs) => void>(() => {})
  const apply = useStableCallback((reply: Promise<Tabs> | undefined) => {
    void reply?.then(accept.current).catch((cause) => setError(String(cause)))
  })
  useEffect(() => {
    const api = window.go?.main.desktopApp
    const runtime = window.runtime
    if (!api || !runtime) {
      setError('Desktop runtime is unavailable')
      return
    }
    let disposed = false
    const update = (next: Tabs) => {
      if (disposed || next.revision < latest.current.revision) return
      const previous = latest.current
      latest.current = next
      const active = next.tabs.find((tab) => tab.id === next.active)
      runtime.WindowSetTitle(
        active ? `ghl — ${active.name} (prototype)` : 'ghl — desktop prototype',
      )
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
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [apply])
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
  return (
    <div className="desktop-shell">
      <style>{desktopStyles}</style>
      <div className="desktop-tabbar">
        <div role="tablist" aria-label="Open reviews" className="desktop-tabs">
          {state.tabs.map((tab, index) => {
            const query = new URL(tab.route, location.href).searchParams
            const comparison = `${query.get('base') ?? 'Auto base'} → ${query.get('target') ?? 'Working tree'}`
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
                  title={`${tab.name} · ${comparison}`}
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
                    activate(nextTab.id)
                    document.getElementById(`review-tab-${nextTab.id}`)?.focus()
                  }}
                >
                  <span>{tab.name}</span>
                  <small>{comparison}</small>
                </button>
                <button
                  className="desktop-tab-close"
                  aria-label={`Close ${tab.name}`}
                  title="Close review"
                  onClick={() => close(tab.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )
          })}
        </div>
        <button
          className="desktop-open"
          aria-label="Open repository"
          title="Open repository (⌘O)"
          onClick={open}
        >
          +
        </button>
      </div>
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
          <Review key={active.id} onRouteChange={routeChanged} />
        </div>
      ) : (
        <div className="desktop-empty">
          <h1>ghl</h1>
          <p>Open a repository to start a review.</p>
          <button className="button primary" onClick={open}>
            Open repository…
          </button>
        </div>
      )}
    </div>
  )
}
