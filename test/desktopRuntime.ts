// The desktop document in Chrome: the built UI, a real Go API and simulated Wails bindings.
import { preview } from 'vite'
import type { Page } from 'puppeteer-core'
import { BRIDGE, simulateDesktopRuntime, type DesktopTab } from '../desktop/simulator.ts'

/**
 * Serve `task desktop:assets` as the Wails asset handler would, forwarding API calls to `api`.
 *
 * Only API paths are proxied: a review route has to load the desktop document,
 * not whatever page the Go server would answer with.
 */
export async function serveDesktopUI(api: string) {
  const server = await preview({
    configFile: false,
    root: 'web',
    logLevel: 'warn',
    build: { outDir: '../desktop/assets' },
    preview: { host: '127.0.0.1', port: 0, proxy: { '^/(r/[^/]+/)?api/': api } },
  })
  const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, '')
  if (!origin) throw new Error('the desktop UI server has no address')
  return { origin, close: () => server.close() }
}

/** Simulate the desktop runtime in every document `page` loads. */
export function installDesktopRuntime(page: Page, tabs?: DesktopTab[]) {
  return page.evaluateOnNewDocument(simulateDesktopRuntime, tabs ?? null, BRIDGE)
}
