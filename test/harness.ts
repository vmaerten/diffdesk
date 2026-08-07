import { existsSync } from 'node:fs'
import { platform } from 'node:process'

import { launch, type Browser, type Page } from 'puppeteer-core'

import { createGhlServer, listen, repoIdFor } from '../src/server.ts'

/** Where Chrome usually lives, unless CHROME_PATH says otherwise. */
const CHROME_CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
}

export function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_PATH does not exist: ${fromEnv}`)
    return fromEnv
  }
  const found = (CHROME_CANDIDATES[platform] ?? []).find((path) => existsSync(path))
  if (!found) throw new Error(`no Chrome found on ${platform}; set CHROME_PATH`)
  return found
}

export interface Harness {
  page: Page
  /** URL of the served repository, with an optional query string. */
  url: (query?: string) => string
  /** Everything the page logged as an error or threw. */
  errors: string[]
  /** Load the UI and wait for the tree, which is the last thing to appear. */
  load: (query?: string) => Promise<void>
}

export interface Suite {
  name: string
  run: (harness: Harness, check: Check) => Promise<void>
}

export type Check = (name: string, ok: boolean, detail?: string) => void

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export { sleep }

/**
 * Serve `repoPath` and drive it with one browser, reused across suites.
 *
 * The server runs in this process rather than as a child: the suites are about
 * the UI, and a spawned CLI only adds a port to guess and a signal to forward.
 */
export async function withHarness<T>(
  repoPath: string,
  body: (make: (target?: string) => Promise<Harness>, browser: Browser) => Promise<T>,
): Promise<T> {
  const server = createGhlServer({ repos: [{ repoPath }] })
  const port = await listen(server, 0)
  const base = `http://127.0.0.1:${port}/r/${repoIdFor(repoPath)}`

  const browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })

  try {
    const make = async (target?: string): Promise<Harness> => {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => {
        errors.push(error instanceof Error ? error.message : String(error))
      })
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`)
      })

      const url = (query?: string) => {
        const suffix = query ?? (target ? `?target=${encodeURIComponent(target)}` : '')
        return `${base}${suffix}`
      }

      const load = async (query?: string) => {
        await page.goto(url(query), { waitUntil: 'networkidle0' })
        await page.waitForSelector('file-tree-container', { timeout: 30_000 })
        // The tree mounts before Shiki has finished with the diff pane.
        await sleep(2500)
      }

      return { page, url, errors, load }
    }

    return await body(make, browser)
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/**
 * Rows currently mounted in the tree, which lives in a shadow DOM.
 *
 * `name` is read from `aria-label` rather than `textContent`: the row renders
 * its name twice for overflow measurement, so the text is doubled.
 */
export const TREE_ROWS = `(() => {
  const root = document.querySelector('file-tree-container')?.shadowRoot
  if (!root) return { rows: [], dirs: [], files: [], selected: [], icons: 0 }
  const items = [...root.querySelectorAll('[role="treeitem"]')]
  const rows = items.map((el) => ({
    name: el.getAttribute('aria-label') ?? '',
    path: el.getAttribute('data-item-path') ?? '',
    kind: el.getAttribute('data-item-type') ?? '',
    status: el.getAttribute('data-item-git-status'),
    open: el.getAttribute('aria-expanded') === 'true',
    selected: el.getAttribute('aria-selected') === 'true',
    decoration: el.textContent ?? '',
  }))
  return {
    rows,
    dirs: rows.filter((r) => r.kind === 'folder'),
    files: rows.filter((r) => r.kind === 'file'),
    selected: rows.filter((r) => r.selected),
    icons: root.querySelectorAll('svg').length,
  }
})()`

/**
 * Open a ref picker and wait for the refs themselves.
 *
 * Waiting on `.picker-item` is not enough: the target picker renders its
 * "this checkout" entry immediately, while the refs are still being fetched. A
 * suite that typed into that gap selected the working tree whatever it typed,
 * and then asserted against the wrong revision.
 */
export async function openPicker(page: Page, key: 'b' | 't'): Promise<void> {
  await page.keyboard.press(key)
  await page.waitForSelector('.picker-input', { timeout: 15_000 })
  await page.waitForFunction(
    `!document.querySelector('.picker-list')?.textContent?.includes('Loading refs')`,
    { timeout: 15_000 },
  )
  await page.waitForSelector('.picker-item', { timeout: 15_000 })
}

/**
 * Wait until the tree has rows again.
 *
 * Switching the reviewed revision tears the tree down and rebuilds it, and a
 * fixed delay reads it mid-flight — as an empty list, which then looks like a
 * lost fold rather than a race.
 */
export async function waitForRows(page: Page, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
    if (rows.length > 0) return rows.length
    if (Date.now() > deadline) return 0
    await sleep(250)
  }
}

/**
 * Every row in the tree, not only the mounted window.
 *
 * The tree virtualises, so a row can be absent from the DOM simply for sitting
 * below the fold — which is how an assertion on "the file I just marked" fails
 * for the wrong reason.
 */
export async function allTreeRows(page: Page): Promise<TreeRow[]> {
  const height = (await page.evaluate(`${TREE_SCROLLER}.scrollHeight`)) as number
  const seen = new Map<string, TreeRow>()
  for (let top = 0; top <= height; top += 400) {
    await page.evaluate(`${TREE_SCROLLER}.scrollTop = ${top}`)
    await sleep(150)
    const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
    for (const row of rows) seen.set(row.path, row)
  }
  await page.evaluate(`${TREE_SCROLLER}.scrollTop = 0`)
  await sleep(200)
  return [...seen.values()]
}

export interface TreeRow {
  name: string
  path: string
  kind: string
  status: string | null
  open: boolean
  selected: boolean
  decoration: string
}

/** The tree's own scroller, the element that proves it virtualises. */
export const TREE_SCROLLER = `document.querySelector('file-tree-container').shadowRoot
  .querySelector('[data-file-tree-virtualized-scroll]')`
