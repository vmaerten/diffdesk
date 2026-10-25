// Simulated Wails bindings, so the desktop UI runs in a browser: the dev server and the UI tests.
import { readFileSync } from 'node:fs'

export interface DesktopTab {
  id: string
  name: string
  path: string
  route: string
}

/**
 * The bindings the Go side registers, then the bridge Wails injects, for one document.
 *
 * Without `given` tabs, a document loaded on a review route opens as the only
 * tab, so a review is reached by URL as in a browser. `window.desktopFixture`
 * records what the page asked of the native side. Its settings outlive a
 * reload, as the Go side's file does, and are shared with the other pages of
 * the browser context, as with the Settings window: a save reaches each of
 * them as Go's event. Runs in the page: it must stay self-contained.
 */
export function simulateDesktopRuntime(given: DesktopTab[] | null, bridgeSource: string) {
  const route = location.pathname + location.search
  const repoId = decodeURIComponent(location.pathname.split('/')[2] ?? '')
  const opened =
    given ??
    (location.pathname.startsWith('/r/') ? [{ id: '1', name: repoId, path: '', route }] : [])
  const state = { revision: 1, active: opened[0]?.id ?? '', tabs: opened }
  const fixture = {
    clipboard: '',
    get settings() {
      return localStorage.getItem('desktopFixture.settings') ?? ''
    },
    revealed: [] as string[],
    fileMenus: [] as { path: string; viewed: boolean }[],
    settingsOpened: 0,
  }
  type Snapshot = typeof state
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  const emit = (name: string, data: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(data)
  }
  const windows = new BroadcastChannel('desktopFixture')
  windows.addEventListener('message', (event: MessageEvent<{ name: string; data: unknown }>) =>
    emit(event.data.name, event.data.data),
  )
  const snapshot = (): Snapshot => structuredClone(state)
  const publish = () => {
    state.revision++
    emit('desktop:tabs', snapshot())
    return snapshot()
  }
  const runtime = {
    EventsOn: (name: string, callback: (data: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(callback)
      return () => listeners.get(name)!.delete(callback)
    },
    WindowSetTitle: () => {},
    ClipboardSetText: async (text: string) => {
      fixture.clipboard = text
      return true
    },
    ClipboardGetText: async () => fixture.clipboard,
  }
  Object.assign(window, { desktopFixture: fixture, runtime })
  window.go = {
    main: {
      desktopApp: {
        Tabs: async () => snapshot(),
        ActivateTab: async (id) => {
          state.active = id
          return publish()
        },
        CloseTab: async (id) => {
          const index = state.tabs.findIndex((tab) => tab.id === id)
          if (index < 0) return snapshot()
          state.tabs.splice(index, 1)
          if (state.active === id)
            state.active = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? ''
          return publish()
        },
        UpdateTabURL: async (id, next) => {
          const tab = state.tabs.find((candidate) => candidate.id === id)
          if (!tab || id !== state.active) return snapshot()
          tab.route = next
          return publish()
        },
        OpenRepository: async () => {},
        OpenSettings: async () => {
          fixture.settingsOpened += 1
        },
        SaveTabView: async () => {},
        Settings: async () => fixture.settings,
        SaveSettings: async (raw) => {
          localStorage.setItem('desktopFixture.settings', raw)
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has no target origin.
          windows.postMessage({ name: 'desktop:settings', data: raw })
          emit('desktop:settings', raw)
        },
        RevealInFinder: async (_tab, path) => {
          fixture.revealed.push(path)
        },
        OpenFileMenu: async (path, _x, _y, viewed) => {
          fixture.fileMenus.push({ path, viewed })
        },
      },
    },
  }
  new Function(bridgeSource)()
}

export const BRIDGE = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8')
