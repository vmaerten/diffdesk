import { existsSync } from 'node:fs'
import { platform } from 'node:process'

import { launch, type Browser, type Page } from 'puppeteer-core'

import { fakeLanguageServers, serveGo } from './goBinary.ts'
import { installDesktopRuntime, serveDesktopUI } from './desktopRuntime.ts'
import { testBrowserPath } from '../scripts/test-browser.ts'

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
  const pinned = testBrowserPath()
  if (platform === 'darwin' && process.arch === 'arm64' && existsSync(pinned)) return pinned
  const found = (CHROME_CANDIDATES[platform] ?? []).find((path) => existsSync(path))
  if (!found) throw new Error(`no Chrome found on ${platform}; set CHROME_PATH`)
  return found
}

export interface Harness {
  page: Page
  /**
   * The fixture being served.
   *
   * Exposed so a suite can change the repository under the UI — the only way to
   * exercise anything that reacts to the code moving. A suite given its own
   * fixture may leave it dirty; one sharing the server's owes the next a clean tree.
   */
  repoPath: string
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
 * Wait until `expression` is truthy in the page.
 *
 * Resolves false after `timeoutMs` instead of throwing, so the check that
 * follows reports what the page shows rather than a timeout.
 */
export async function until(page: Page, expression: string, timeoutMs = 10_000) {
  try {
    await page.waitForFunction(expression, { timeout: timeoutMs, polling: 50 })
    return true
  } catch {
    return false
  }
}

/** Let the page lay out and paint what the last gesture changed. */
export const frames = (page: Page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )

/**
 * Let any request the last gesture started finish, for up to five seconds.
 *
 * For checks that something did *not* happen: there is no state to wait for,
 * only the absence of a write. A page that never goes quiet is not a failure here.
 */
export const settled = (page: Page) =>
  until(
    page,
    `(({ inflight, last }) => inflight === 0 && performance.now() - last >= 300)(window.requestActivity)`,
    5_000,
  )

/** Some mounted file shows its lines, or every one is folded as viewed. */
const DIFF_RENDERED = `(() => {
  const roots = [...document.querySelectorAll('.diff diffs-container')].map((host) => host.shadowRoot)
  return roots.some((root) => root?.querySelector('[data-line]')) ||
    (roots.length > 0 && roots.every((root) => root?.querySelector('[data-title]')))
})()`

/**
 * Serve `repoPath` and drive it with one browser, reused across suites.
 *
 * The suites drive the built desktop UI against the Go API. `make` opens a page
 * on `repoPath`, or on another repository it registers on the same server.
 */
export async function withHarness<T>(
  repoPath: string,
  body: (
    make: (target?: string, repo?: string) => Promise<Harness>,
    browser: Browser,
  ) => Promise<T>,
): Promise<T> {
  const servers = fakeLanguageServers()
  const server = await serveGo(repoPath, [], { GHL_LSP_PATH: servers.path })
  let ui: Awaited<ReturnType<typeof serveDesktopUI>> | undefined
  let browser: Browser | undefined
  try {
    ui = await serveDesktopUI(server.origin)
    const origin = ui.origin
    browser = await launch({
      executablePath: findChrome(),
      headless: 'shell',
      // Suites run side by side: a page that is not in front must still paint,
      // or the virtualised tree and diff never render what a suite scrolls to.
      args: [
        '--no-sandbox',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      defaultViewport: { width: 1600, height: 1000 },
    })

    const make = async (target?: string, repo = repoPath): Promise<Harness> => {
      let repoId = server.repoId
      if (repo !== repoPath) {
        const response = await fetch(`${server.origin}/api/repos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoPath: repo }),
        })
        if (!response.ok) throw new Error(`could not register ${repo}: ${await response.text()}`)
        repoId = ((await response.json()) as { id: string }).id
      }
      const base = `${origin}/r/${repoId}`
      // Its own context, hence its own renderer and storage: pages of one origin
      // would otherwise share a single process and run one at a time.
      const context = await browser!.createBrowserContext()
      const page = await context.newPage()
      page.once('close', () => void context.close())
      await installDesktopRuntime(page)
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
        // The tree mounts before the diff pane, and the pane before its syntax
        // grammars and themes have loaded.
        await until(page, DIFF_RENDERED, 30_000)
        await settled(page)
      }

      return { page, repoPath: repo, url, errors, load }
    }

    return await body(make, browser)
  } finally {
    try {
      await browser?.close()
      await ui?.close()
    } finally {
      await server.close()
      servers.cleanup()
    }
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

/** What the title bar and status bar say about the review, as several suites need to read it. */
export interface TitlebarState {
  base: string | null
  target: string | null
  /** The sidebar's file count. */
  files: number | null
  /** The status bar's items: base source, scope, untracked files. */
  notes: string[]
  /** The capsule's stack button, such as `2/3`: the reviewed layer of how many. */
  stack: string | null
  /** The open stack list: its trunk, then one entry per layer, top first. Empty when closed. */
  trunk: string | null
  layers: { name: string; pr: string | null; current: boolean; merged: boolean; gone: boolean }[]
  /** The scope checkboxes, in order. Empty until `openOptions` shows them. */
  toggles: { label: string; pressed: boolean; off: boolean }[]
  search: string
}

/**
 * Read the title bar and status bar.
 *
 * Shared rather than repeated per suite: the selectors and the caret stripping
 * are markup details, and a change to the chrome would otherwise have to be
 * chased through every suite that reads a revision back.
 */
export function titlebar(page: Page): Promise<TitlebarState> {
  return page.evaluate(`(() => ({
    base: document.querySelector('.capsule-base')?.textContent?.trim() ?? null,
    target: document.querySelector('[aria-label^="Target:"]')?.textContent?.replace('▾', '').trim() ?? null,
    files: Number(document.querySelector('.sidebar-head .counter')?.textContent ?? NaN) || null,
    notes: [...document.querySelectorAll('.review-footer > span')].map((e) => e.textContent.trim()),
    stack: document.querySelector('.capsule-stack')?.textContent?.replace('▾', '').trim() ?? null,
    trunk: document.querySelector('.stack-trunk .stack-branch')?.textContent?.trim() ?? null,
    layers: [...document.querySelectorAll('.stack-row[data-branch]')].map((e) => ({
      name: e.dataset.branch,
      pr: e.querySelector('.stack-pr')?.textContent?.trim() ?? null,
      current: e.classList.contains('current'),
      merged: e.classList.contains('merged'),
      gone: e.querySelector('.stack-branch')?.disabled === true,
    })),
    toggles: [...document.querySelectorAll('.options-popover .scope-check input:is(.worktree, .untracked)')].map((e) => ({
      label: e.closest('label')?.textContent?.trim() ?? '',
      pressed: e.checked === true,
      off: e.disabled,
    })),
    search: location.search,
  }))()`) as Promise<TitlebarState>
}

/**
 * Read until `ready` holds, or `timeoutMs` runs out.
 *
 * Returns the last reading either way, so the check that follows reports what
 * the page actually showed rather than a timeout.
 */
export async function poll<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ready(value) || Date.now() > deadline) return value
    await sleep(100)
  }
}

/** Read the title bar once `ready` holds; see `poll`. */
export const titlebarWhen = (
  page: Page,
  ready: (state: TitlebarState) => boolean,
  timeoutMs = 15_000,
) => poll(() => titlebar(page), ready, timeoutMs)

/** Wait until the open picker's first entry matches what was typed. */
export function pickerShows(page: Page, text: string): Promise<unknown> {
  return page.waitForFunction(
    (wanted) =>
      document
        .querySelector('.picker-item .picker-name')
        ?.textContent?.toLowerCase()
        .includes(wanted.toLowerCase()),
    { timeout: 10_000 },
    text,
  )
}

/** Open the title bar's Options popover, which holds the scope and whitespace checkboxes. */
export async function openOptions(page: Page): Promise<void> {
  if (await page.$('.options-popover')) return
  await page.click('.titlebar-actions button[title="Diff options"]')
  await page.waitForSelector('.options-popover', { timeout: 5_000 })
}

/** Close the Options popover the way a click outside it does. */
export function closeOptions(page: Page): Promise<void> {
  return page.evaluate(() => {
    const backdrop = document.querySelector('.options-popover')?.previousElementSibling
    backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

/** Run a menu command the way the native menu does. */
export function command(page: Page, name: string): Promise<void> {
  return page.evaluate(
    (detail) => void window.dispatchEvent(new CustomEvent('desktop:command', { detail })),
    name,
  )
}

/** The comments side panel, while it is shown. */
export const COMMENTS_OPEN = '.comments-panel:not([hidden])'

/** The sidebar footer's viewed count, as "<viewed> of <files> viewed". */
export const VIEWED_COUNT = `document.querySelector('.sidebar-foot-line span')?.textContent?.trim() ?? null`

/**
 * Open a picker and wait for what it is listing, not merely for a row.
 *
 * Waiting on `.picker-item` is not enough: both pickers render one entry
 * immediately — "this checkout", "All commits" — while the list itself is still
 * being fetched. A suite that typed into that gap selected the standing entry
 * whatever it typed, and then asserted against the wrong revision.
 */
export async function openPicker(page: Page, key: 'b' | 't' | 'l'): Promise<void> {
  await page.keyboard.press(key)
  await page.waitForSelector('.picker-input', { timeout: 15_000 })
  await page.waitForFunction(
    `!/Loading (refs|commits)/.test(document.querySelector('.picker-list')?.textContent ?? '')`,
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
    await frames(page)
    const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
    for (const row of rows) seen.set(row.path, row)
  }
  await page.evaluate(`${TREE_SCROLLER}.scrollTop = 0`)
  await frames(page)
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

/**
 * Click a file's row in the tree, wherever it is.
 *
 * The tree virtualises, so a row below the fold is not in the DOM at all and
 * `querySelector(...)?.click()` silently does nothing — a test written that way
 * asserts against a click that never happened. Returns false when the path is
 * genuinely absent, which is a different failure and should read differently.
 */
export async function clickTreeRow(page: Page, path: string): Promise<boolean> {
  const attempt = () =>
    page.evaluate(`(() => {
      const root = document.querySelector('file-tree-container')?.shadowRoot
      const row = root?.querySelector('[data-item-path="' + ${JSON.stringify(path)} + '"]')
      if (!row) return false
      row.click()
      return true
    })()`) as Promise<boolean>

  if (await attempt()) return true

  const box = (await page.evaluate(`(() => {
    const el = ${TREE_SCROLLER}
    return el ? { height: el.scrollHeight, viewport: el.clientHeight } : null
  })()`)) as { height: number; viewport: number } | null
  if (!box) return false

  const step = Math.max(100, Math.round(box.viewport * 0.8))
  for (let top = 0; top <= box.height; top += step) {
    await page.evaluate(`(() => { ${TREE_SCROLLER}.scrollTop = ${top} })()`)
    await frames(page)
    if (await attempt()) return true
  }
  return false
}

/**
 * The diff pane's own scroller, the element CodeView computes its window from.
 *
 * Scoped to `.diff` on purpose: the sidebar scrolls too, and searching the whole
 * document silently returned the file tree instead.
 */
export const DIFF_SCROLLER = `(() => {
  const pane = document.querySelector('.diff')
  if (!pane) return null
  return [pane, ...pane.querySelectorAll('*')].find((el) => {
    const cs = getComputedStyle(el)
    return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
           el.scrollHeight > el.clientHeight + 20
  }) ?? null
})()`

/** Every mounted file that shows lines has its coloured tokens. */
const DIFF_PAINTED = `[...document.querySelectorAll('.diff diffs-container')].every((host) =>
  !host.shadowRoot?.querySelector('[data-line]') || host.shadowRoot.querySelector('span[style]'))`

/** Each mounted file, read from its own shadow root, with its coloured spans. */
const DIFF_FILES = `(() => {
  const pane = document.querySelector('.diff')
  if (!pane) return []
  return [...pane.querySelectorAll('diffs-container')].map((host) => ({
    name: (host.shadowRoot?.querySelector('[data-title]')?.textContent ?? '').trim(),
    spans: host.shadowRoot?.querySelectorAll('span[style]').length ?? 0,
  }))
})()`

/**
 * One file of the diff pane, read where it is mounted, or found by walking the
 * scroll when it is not.
 */
export async function diffFile(page: Page, name: string): Promise<DiffFile | undefined> {
  const mounted = ((await page.evaluate(DIFF_FILES)) as DiffFile[]).find((file) =>
    file.name.includes(name),
  )
  return mounted ?? (await allDiffFiles(page)).find((file) => file.name.includes(name))
}

export interface DiffFile {
  name: string
  /** Coloured tokens. Zero means the file rendered, but empty. */
  spans: number
}

/**
 * The files actually intersecting the viewport right now.
 *
 * Distinct from `allDiffFiles`, which walks the whole scroll: this one answers
 * "did the pane move to it", not "does it exist somewhere". Counting characters
 * instead was not enough — when the virtual window froze, the sticky header
 * dragged the same block along and the count came back identical at every
 * scroll position.
 */
export const DIFF_ON_SCREEN = `(() => {
  const el = ${DIFF_SCROLLER}
  if (!el) return []
  const box = el.getBoundingClientRect()
  const names = []
  for (const host of el.querySelectorAll('diffs-container')) {
    const r = host.getBoundingClientRect()
    if (r.bottom <= box.top || r.top >= box.bottom || r.height === 0) continue
    const title = host.shadowRoot?.querySelector('[data-title]')
    names.push((title?.textContent ?? '').trim())
  }
  return names
})()`

/**
 * Every file the diff pane renders, not only the mounted window.
 *
 * Asserting a file is *there* needs the whole scroll just as much as asserting
 * it is absent: the pane virtualises, so at rest it holds four files out of
 * fifty. The step stays under one viewport so nothing slips between samples.
 *
 * It moves the pane and leaves it back at the top, so anything asserting *where
 * the reader is* has to be read before this runs, never after — otherwise it
 * measures this helper rather than the application.
 */
export async function allDiffFiles(page: Page): Promise<DiffFile[]> {
  const seen = new Map<string, DiffFile>()
  const collect = async () => {
    for (const file of (await page.evaluate(DIFF_FILES)) as DiffFile[]) {
      if (!file.name) continue
      // Keep the richest reading: a file caught mid-render reports no spans yet.
      const previous = seen.get(file.name)
      if (!previous || file.spans > previous.spans) seen.set(file.name, file)
    }
  }

  const box = (await page.evaluate(`(() => {
    const el = ${DIFF_SCROLLER}
    return el ? { height: el.scrollHeight, viewport: el.clientHeight } : null
  })()`)) as { height: number; viewport: number } | null

  await collect()
  if (!box) return [...seen.values()]

  const step = Math.max(200, Math.round(box.viewport * 0.8))
  for (let top = 0; top <= box.height; top += step) {
    await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop = ${top} })()`)
    await frames(page)
    // Highlighting lands after the rows; a file without tokens stops it after a second.
    await until(page, DIFF_PAINTED, 1_000)
    await collect()
  }
  await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop = 0 })()`)
  await frames(page)
  return [...seen.values()]
}
