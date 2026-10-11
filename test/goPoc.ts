import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import { asMarkdown } from '../src/export.ts'
import type { DiffFiles, DiffPayload, ServedComment } from '../src/types.ts'
import { clickTreeRow, DIFF_SCROLLER, findChrome, sleep } from './harness.ts'

const temporary = mkdtempSync(join(tmpdir(), 'ghl-go-poc-test-'))
const repo = join(temporary, 'repository')
mkdirSync(repo)
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const write = (path: string, contents: string) => writeFileSync(join(repo, path), contents)
const original = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const modified = original
  .replace('line 10\n', 'committed 10\n')
  .replace('line 80\n', 'working 80\n')

interface Running {
  process: ChildProcess
  port: number
  repoId: string
  url: string
}
const binary = join(temporary, 'ghl-go-poc')
const onlyGit = join(temporary, 'path')
mkdirSync(onlyGit)
symlinkSync(
  execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
  join(onlyGit, 'git'),
)
copyFileSync(fileURLToPath(new URL('../poc/go/dist/ghl-go-poc', import.meta.url)), binary)

async function startServer(): Promise<Running> {
  const child = spawn(binary, ['--repo', repo, '--base', 'main', '--no-open', '--json'], {
    cwd: temporary,
    env: { ...env, PATH: onlyGit },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const lines = createInterface({ input: child.stdout! })
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000)
  try {
    const line = await Promise.race([
      once(lines, 'line').then(([value]) => String(value)),
      once(child, 'exit').then(() => {
        throw new Error(`Go startup failed: ${stderr}`)
      }),
    ])
    const info: Omit<Running, 'process'> = JSON.parse(line)
    return { ...info, process: child }
  } finally {
    clearTimeout(timer)
    lines.close()
  }
}
async function stop(running: Running) {
  if (running.process.exitCode !== null || running.process.signalCode !== null) return
  const exited = once(running.process, 'exit')
  running.process.kill('SIGINT')
  const timer = setTimeout(() => running.process.kill('SIGKILL'), 6000)
  try {
    const [code] = await exited
    assert.equal(code, 0, 'clean Ctrl-C shutdown')
  } finally {
    clearTimeout(timer)
  }
}
async function json<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const options: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) options.body = JSON.stringify(body)
  const response = await fetch(url, options)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<T>
}
const diffFilesContract = (files: DiffFiles) => ({
  oldFile: files.oldFile && {
    name: files.oldFile.name,
    contents: files.oldFile.contents,
    cacheKey: files.oldFile.cacheKey,
  },
  newFile: {
    name: files.newFile.name,
    contents: files.newFile.contents,
    cacheKey: files.newFile.cacheKey,
  },
})

const check = (message: string) => console.log(`  ok ${message}`)

let go: Running | undefined
const node = createGhlServer({ repos: [{ repoPath: repo }] })
try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  // Node's patch parser requires unquoted Unicode paths. Go also tests default quoting.
  git('config', 'core.quotepath', 'false')
  write('context.txt', original)
  write('old name é.txt', 'rename\n')
  write('deleted.txt', 'gone\n')
  write('binary.bin', '\0old')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feature')
  write('context.txt', original.replace('line 10\n', 'committed 10\n'))
  git('mv', 'old name é.txt', 'renamed é.txt')
  rmSync(join(repo, 'deleted.txt'))
  write('added.txt', 'added\n')
  git('add', '-A')
  git('commit', '-qm', 'feature')
  write('staged.txt', 'staged\n')
  git('add', 'staged.txt')
  write('context.txt', modified)
  write('binary.bin', '\0new')
  write('untracked.txt', 'excluded\n')

  go = await startServer()
  const port = await listen(node, 0)
  const nodeBase = `http://127.0.0.1:${port}/r/${repoIdFor(repo)}/api/`
  const goBase = () => `http://127.0.0.1:${go!.port}/r/${go!.repoId}/api/`
  const diff = (suffix = '') => json<DiffPayload>(goBase() + `diff?base=main${suffix}`)

  for (const suffix of ['', '&committed=1']) {
    const [a, b] = await Promise.all([
      diff(suffix),
      json<DiffPayload>(nodeBase + `diff?base=main${suffix}`),
    ])
    for (const field of [
      'comparison',
      'patch',
      'totals',
      'files',
      'range',
      'head',
      'target',
    ] as const)
      assert.deepEqual(a[field], b[field], field)
    for (const file of a.files.filter((f) => !f.binary)) {
      const query = new URLSearchParams({
        base: 'main',
        path: file.path,
        hash: file.hash!,
        comparison: JSON.stringify(a.comparison),
      })
      if (suffix) query.set('committed', '1')
      const [goFiles, nodeFiles] = await Promise.all([
        json<DiffFiles>(goBase() + `diff-files?${query}`),
        json<DiffFiles>(nodeBase + `diff-files?${query}`),
      ])
      assert.deepEqual(
        diffFilesContract(goFiles),
        diffFilesContract(nodeFiles),
        `context ${file.path}`,
      )
    }
  }
  check('Node/Go parity: patch, counts, hashes, versions and cache keys in both scopes')

  const data = await diff()
  const saved: ServedComment[] = []
  for (const [side, start, end] of [
    ['additions', 10, 10],
    ['deletions', 10, 10],
    ['additions', 90, 91],
  ] as const) {
    const c = {
      id: `${side}-${start}`,
      path: 'context.txt',
      side,
      start,
      end,
      range: data.range,
      body: 'review',
    }
    const [a, b] = await Promise.all([
      json<{ comment: ServedComment }>(goBase() + 'comments?base=main', 'POST', c),
      json<{ comment: ServedComment }>(nodeBase + 'comments?base=main', 'POST', c),
    ])
    const { createdAt: goTime, ...goComment } = a.comment
    const { createdAt: nodeTime, ...nodeComment } = b.comment
    assert.deepEqual(goComment, nodeComment)
    assert.ok(goTime && nodeTime)
    saved.push(a.comment)
  }
  const c = saved[0]!
  const edited = await json<{ comment: ServedComment }>(goBase() + 'comments?base=main', 'PATCH', {
    id: c.id,
    body: 'edited',
  })
  const editedNode = await json<{ comment: ServedComment }>(
    nodeBase + 'comments?base=main',
    'PATCH',
    { id: c.id, body: 'edited' },
  )
  assert.deepEqual(edited.comment.anchor, editedNode.comment.anchor)
  assert.equal(edited.comment.createdAt, c.createdAt)
  const viewedBody = {
    range: data.range,
    path: 'context.txt',
    hash: data.files.find((f) => f.path === 'context.txt')!.hash,
    viewed: true,
  }
  const viewed = await json(goBase() + 'viewed', 'POST', viewedBody)
  assert.deepEqual(viewed, await json(nodeBase + 'viewed', 'POST', viewedBody))
  write('context.txt', modified.replace('line 90\n', 'updated 90\n'))
  const [a, b] = await Promise.all([diff(), json<DiffPayload>(nodeBase + 'diff?base=main')])
  assert.deepEqual(
    a.comments.map(({ createdAt: _time, ...rest }) => rest),
    b.comments.map(({ createdAt: _time, ...rest }) => rest),
  )
  assert.deepEqual(a.viewed, b.viewed)
  assert.ok(a.comments.find((comment) => comment.start === 90)?.stale)
  for (const comment of saved) {
    await Promise.all([
      json(goBase() + `comments?id=${comment.id}`, 'DELETE'),
      json(nodeBase + `comments?id=${comment.id}`, 'DELETE'),
    ])
  }
  await json(goBase() + 'viewed', 'POST', { range: data.range, clear: true })
  write('context.txt', modified)
  check(
    'Node/Go parity: anchors on both sides, context, edits, deletion, stale comments and Viewed',
  )

  const html = await (await fetch(go.url)).text()
  assert.ok(html.includes('<html'))
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    const response: Response = await fetch(`http://127.0.0.1:${go.port}${match[1]}`)
    assert.equal(response.status, 200)
    assert.ok((await response.arrayBuffer()).byteLength > 100)
  }
  check('standalone binary outside checkout, PATH contains only Git, embedded HTML/JS/CSS served')

  git('config', 'core.quotepath', 'true')

  const browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(String(err)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    let contextRequests = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/diff-files?')) contextRequests++
    })
    const load = async () => {
      await page.goto(go!.url, { waitUntil: 'networkidle0' })
      await page.waitForSelector('.viewed-toggle input')
      await sleep(400)
    }
    await load()
    assert.equal(await page.$('button.ref.base'), null)
    assert.equal(await page.$('button.ref.target'), null)
    assert.equal(await page.$('.commit-group'), null)
    assert.equal(await page.$('input.untracked'), null)
    for (const key of ['b', 't', 'l'] as const) {
      await page.keyboard.press(key)
      assert.equal(await page.$('.picker-input'), null)
    }
    const shortcuts = await page.$eval('.shortcuts', (el) => el.textContent ?? '')
    assert.ok(!/Choose (base|target|commit)/.test(shortcuts))
    await page.click('input.worktree')
    await page.waitForNetworkIdle()
    assert.ok(!(await page.$eval('input.worktree', (el) => (el as HTMLInputElement).checked)))
    await page.click('input.worktree')
    await page.waitForNetworkIdle()
    await page.select('.theme-picker select', 'github-light')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'github-light')
    assert.ok(await clickTreeRow(page, 'context.txt'))
    await sleep(300)
    const root = `[...document.querySelectorAll('.diff diffs-container')].find(host => host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim() === 'context.txt')?.shadowRoot`
    const expanded = await page.evaluate(
      `(() => { const button = (${root})?.querySelector('[data-expand-index="1"] [data-expand-up]'); button?.click(); return Boolean(button) })()`,
    )
    assert.ok(expanded, 'expansion control exists')
    await page.waitForNetworkIdle()
    assert.equal(contextRequests, 1)
    // The first expansion reveals lines 14..33. Comment on previously hidden context.
    const point = (await page.evaluate(
      `(() => { const rect = (${root})?.querySelector('[data-column-number="20"]')?.getBoundingClientRect(); return rect ? { x: rect.x + 4, y: rect.y + rect.height / 2 } : null })()`,
    )) as { x: number; y: number } | null
    assert.ok(point, 'expanded gutter exists')
    await page.mouse.click(point.x, point.y)
    await page.keyboard.press('c')
    await page.waitForSelector('.comment-composer textarea', { visible: true })
    await page.type('.comment-composer textarea', 'Browser context comment')
    await page.click('.comment-composer footer button:last-child')
    await page.waitForNetworkIdle()
    const fromUI = (await diff()).comments.find(
      (comment) => comment.body === 'Browser context comment',
    )!
    assert.deepEqual(fromUI.anchor, ['line 20'])
    const copied = await page.evaluate(
      `(async () => { let text = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { text = value } } }); document.querySelector('.copy-all').click(); await Promise.resolve(); return text })()`,
    )
    assert.equal(copied, asMarkdown([fromUI], { range: data.range }))
    await page.click('.comments-trigger')
    await page.waitForSelector('.comments-panel[open]')
    await page.click('.comments-panel .comment-menu summary')
    await page.click('.comments-panel .comment-menu-items button:first-child')
    await page.waitForSelector('.panel-editor textarea')
    await page.$eval('.panel-editor textarea', (el) => (el as HTMLTextAreaElement).select())
    await page.type('.panel-editor textarea', 'Edited in browser')
    await page.click('.panel-editor button[type="submit"]')
    await page.waitForNetworkIdle()
    assert.equal((await diff()).comments[0]?.body, 'Edited in browser')
    await page.keyboard.press('Escape')
    await page.evaluate(
      `(() => { const host = [...document.querySelectorAll('.diff diffs-container')].find(host => host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim() === 'context.txt'); host?.querySelector('.viewed-toggle input')?.click() })()`,
    )
    await page.waitForNetworkIdle()
    const marked = await diff()
    assert.deepEqual(Object.keys(marked.viewed), ['context.txt'])
    await load()
    assert.equal(
      await page.$eval('.theme-picker select', (el) => (el as HTMLSelectElement).value),
      'github-light',
    )
    assert.ok((await page.$eval('.sidebar-head', (el) => el.textContent ?? '')).includes('1/'))
    await stop(go)
    go = await startServer()
    await load()
    assert.equal(Object.keys((await diff()).viewed).length, 1)
    await page.click('.comments-trigger')
    await page.waitForSelector('.comments-panel[open]')
    assert.ok(
      (await page.$eval('.comments-panel', (el) => el.textContent ?? '')).includes(
        'Edited in browser',
      ),
    )
    await page.keyboard.press('Escape')
    write('context.txt', original)
    await page.click('.refresh')
    await page.waitForNetworkIdle()
    await page.click('.comments-trigger')
    await page.waitForSelector('.comments-panel[open]')
    assert.ok(
      (await page.$eval('.comments-panel', (el) => el.textContent ?? '')).includes(
        'Outside the current diff',
      ),
    )
    assert.deepEqual((await diff()).comments[0]?.anchor, ['line 20'])
    await page.click('.comments-panel .comment-menu summary')
    await page.click('.comments-panel .comment-menu-items button:last-child')
    await page.waitForNetworkIdle()
    assert.equal((await diff()).comments.length, 0)
    await page.keyboard.press('Escape')
    // Refresh uses the current query and clears a tick whose patch changed.
    write('context.txt', modified.replace('working 80', 'new work 80'))
    await page.click('.refresh')
    await page.waitForNetworkIdle()
    assert.equal(Object.keys((await diff()).viewed).length, 0)
    // Search and split view remain available in the PoC.
    await page.click('.view-toggle button:last-child')
    assert.equal(
      await page.$eval('.view-toggle button:last-child', (el) => el.getAttribute('aria-pressed')),
      'true',
    )
    await page.keyboard.down('Meta')
    await page.keyboard.press('f')
    await page.keyboard.up('Meta')
    await page.waitForSelector('.diff-search input', { visible: true })
    await page.type('.diff-search input', 'new work')
    await sleep(200)
    assert.ok((await page.$eval('.diff-search', (el) => el.textContent ?? '')).includes('1'))
    assert.deepEqual(errors, [])
    // Ensure expanded content was supplied by Go, not only rendered from the patch.
    assert.ok(contextRequests >= 1)
    await page.evaluate(`(() => { const el = ${DIFF_SCROLLER}; if (el) el.scrollTop = 0 })()`)
    check(
      'browser: scopes, excluded controls/shortcuts, theme, expansion, comment/edit/copy/delete, Viewed, refresh and restart',
    )
  } finally {
    await browser.close()
  }
} finally {
  if (go) await stop(go)
  if (node.listening) await new Promise<void>((resolve) => node.close(() => resolve()))
  rmSync(temporary, { recursive: true, force: true })
}
