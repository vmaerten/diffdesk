import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

import { createHash } from 'node:crypto'
import { asExport, asMarkdown } from '../src/export.ts'
import type { DiffFiles, DiffPayload, ServedComment } from '../src/types.ts'
import { clickTreeRow, DIFF_SCROLLER, findChrome, sleep } from './harness.ts'

const production = process.argv[2] === 'go'
const name = production ? 'ghl' : 'ghl-go-poc'
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
const binary = join(temporary, name)
const onlyGit = join(temporary, 'path')
mkdirSync(onlyGit)
symlinkSync(
  execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
  join(onlyGit, 'git'),
)
copyFileSync(
  production ? goBinary() : fileURLToPath(new URL('../poc/go/dist/ghl-go-poc', import.meta.url)),
  binary,
)

async function startServer(): Promise<Running> {
  const child = spawn(
    binary,
    [
      '--repo',
      repo,
      '--base',
      'main',
      '--no-open',
      '--json',
      ...(production ? ['--no-daemon', '--port', '0'] : []),
    ],
    {
      cwd: temporary,
      env: { ...env, PATH: onlyGit },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
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
const check = (message: string) => console.log(`  ok ${message}`)

let go: Running | undefined
try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  // Exercise unquoted Unicode paths before repeating browser checks with quoting.
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
  if (production) {
    mkdirSync(join(repo, 'nested'))
    write('nested/space é.txt', 'first\nsecond without newline')
    write('nested/.gitattributes', 'binary.txt -diff\n')
    write('nested/binary.txt', 'classified as binary by attributes\n')
    write('empty-untracked.txt', '')
    write('untracked.bin', '\0binary')
    write('.gitignore', 'ignored.txt\n')
    write('ignored.txt', 'excluded by Git\n')
  }

  // Version works outside a repository and with no Git or toolchain in PATH.
  const metadata = JSON.parse(
    execFileSync(binary, ['--version', '--json'], {
      cwd: temporary,
      env: { ...env, PATH: '' },
      encoding: 'utf8',
    }),
  )
  assert.equal(
    metadata.version,
    process.env.GHL_TEST_VERSION ??
      process.env.GHL_BUILD_VERSION ??
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  )
  assert.match(metadata.commit, /^[a-f0-9]{40}(-dirty)?$/)
  assert.ok(Number.isFinite(Date.parse(metadata.buildDate)))
  assert.equal(metadata.runtime, 'go')
  assert.equal(metadata.protocolVersion, 1)
  assert.ok(
    execFileSync(binary, ['--version'], {
      cwd: temporary,
      env: { ...env, PATH: '' },
      encoding: 'utf8',
    }).startsWith(`${name} `),
  )
  go = await startServer()
  const health = await json<Record<string, unknown>>(`http://127.0.0.1:${go.port}/api/health`)
  for (const [key, value] of Object.entries(metadata)) assert.deepEqual(health[key], value)
  assert.equal(health.ghlGo, true)
  assert.equal(health.ghlGoPoc, production ? undefined : true)
  assert.equal(health.ghl, undefined, 'unfinished daemon protocol is not advertised to Node')
  check(`version and health identify ${name} with matching build metadata`)
  const goBase = () => `http://127.0.0.1:${go!.port}/r/${go!.repoId}/api/`
  const diff = (suffix = '') => json<DiffPayload>(goBase() + `diff?base=main${suffix}`)

  for (const suffix of production
    ? [
        '',
        '&committed=1',
        '&untracked',
        '&committed=1&untracked',
        '&target=HEAD&untracked',
        '&commit=HEAD&untracked',
      ]
    : ['', '&committed=1']) {
    const a = await diff(suffix)
    assert.equal(a.totals.files, a.files.length)
    assert.equal(
      a.totals.additions,
      a.files.reduce((sum, f) => sum + f.additions, 0),
    )
    assert.equal(
      a.totals.deletions,
      a.files.reduce((sum, f) => sum + f.deletions, 0),
    )
    if (!suffix.includes('&untracked') || a.comparison.after) {
      const expected = execFileSync(
        'git',
        [
          '-C',
          repo,
          'diff',
          '--no-ext-diff',
          '--no-color',
          '--find-renames',
          a.comparison.before,
          ...(a.comparison.after ? [a.comparison.after] : []),
        ],
        { env, encoding: 'utf8' },
      )
      assert.equal(a.patch, expected)
    }
    for (const file of a.files.filter((f) => !f.binary)) {
      const query = new URLSearchParams({
        base: 'main',
        path: file.path,
        hash: file.hash!,
        comparison: JSON.stringify(a.comparison),
      })
      for (const [key, value] of new URLSearchParams(suffix.slice(1))) query.set(key, value)
      const context = await json<DiffFiles>(goBase() + `diff-files?${query}`)
      const oldName = file.path === 'renamed é.txt' ? 'old name é.txt' : file.path
      const before = ['added', 'untracked'].includes(file.status)
        ? ''
        : execFileSync('git', ['-C', repo, 'show', `${a.comparison.before}:${oldName}`], {
            env,
            encoding: 'utf8',
          })
      const after =
        file.status === 'deleted'
          ? ''
          : a.comparison.after
            ? execFileSync('git', ['-C', repo, 'show', `${a.comparison.after}:${file.path}`], {
                env,
                encoding: 'utf8',
              })
            : readFileSync(join(repo, file.path), 'utf8')
      if (context.oldFile) assert.equal(context.oldFile.contents, before)
      assert.equal(context.newFile.contents, after)
      for (const version of [context.oldFile, context.newFile]) {
        if (!version || version.cacheKey === 'empty') continue
        const bytes = Buffer.from(version.contents)
        const expectedKey = createHash('sha256')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex')
        assert.equal(version.cacheKey, expectedKey)
      }
    }
  }
  check('Git patch, counts, versions and blob cache keys in both scopes')

  if (production) {
    const included = await diff('&untracked')
    const file = included.files.find((entry) => entry.path === 'untracked.txt')!
    const comment = {
      id: 'untracked',
      path: file.path,
      side: 'additions',
      start: 1,
      end: 1,
      body: 'New file remark',
      range: included.range,
    }
    const created = await json<{ comment: ServedComment }>(
      goBase() + 'comments?base=main&untracked',
      'POST',
      comment,
    )
    assert.deepEqual(created.comment.anchor, ['excluded'])
    assert.deepEqual(created.comment.code, ['excluded'])
    await json(goBase() + 'viewed', 'POST', {
      range: included.range,
      path: file.path,
      hash: file.hash,
      viewed: true,
    })
    await json(goBase() + 'comments?base=main&untracked', 'PATCH', {
      id: comment.id,
      body: 'Edited new file remark',
    })
    await stop(go)
    go = await startServer()
    assert.equal((await diff('&untracked')).viewed[file.path], file.hash)
    assert.equal((await diff('&untracked')).comments[0]?.createdAt, created.comment.createdAt)
    write('untracked.txt', 'changed\n')
    const staleQuery = new URLSearchParams({
      base: 'main',
      untracked: '',
      path: file.path,
      hash: file.hash!,
    })
    assert.equal((await fetch(goBase() + 'diff-files?' + staleQuery)).status, 409)
    for (const suffix of ['&untracked', '', '&committed', '&target=HEAD']) {
      const a = await diff(suffix)
      assert.deepEqual(a.viewed, {})
      assert.equal(
        asExport(a.comments, { repo, range: a.range }).comments[0]?.body,
        'Edited new file remark',
      )
      const markdown = asMarkdown(a.comments, { range: a.range })
      assert.ok(markdown.includes('Edited new file remark'))
      assert.ok(
        markdown.includes(
          suffix === '&untracked' ? 'changed since the remark' : 'Code is unavailable',
        ),
      )
      assert.deepEqual(a.comments[0]?.anchor, ['excluded'])
    }
    rmSync(join(repo, 'untracked.txt'))
    assert.equal((await fetch(goBase() + 'diff-files?' + staleQuery)).status, 409)
    assert.deepEqual((await diff('&untracked')).comments[0]?.code, [])
    write('untracked.txt', 'excluded\n')
    await json(goBase() + 'comments?id=untracked', 'DELETE')
    await json(goBase() + 'viewed', 'POST', { range: included.range, clear: true })
    check(
      'untracked: ignored paths, Unicode, empty/binary files, attributes, contexts, anchors, stale/export contracts, Viewed and restart',
    )
  }

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
    const a = await json<{ comment: ServedComment }>(goBase() + 'comments?base=main', 'POST', c)
    const expected = (side === 'deletions' ? original : modified).split('\n').slice(start - 1, end)
    assert.deepEqual(a.comment.anchor, expected)
    assert.deepEqual(a.comment.code, expected)
    assert.equal(a.comment.stale, false)
    assert.ok(Number.isFinite(Date.parse(a.comment.createdAt)))
    saved.push(a.comment)
  }
  const c = saved[0]!
  const edited = await json<{ comment: ServedComment }>(goBase() + 'comments?base=main', 'PATCH', {
    id: c.id,
    body: 'edited',
  })
  assert.deepEqual(edited.comment.anchor, c.anchor)
  assert.equal(edited.comment.createdAt, c.createdAt)
  const viewedBody = {
    range: data.range,
    path: 'context.txt',
    hash: data.files.find((f) => f.path === 'context.txt')!.hash,
    viewed: true,
  }
  await json(goBase() + 'viewed', 'POST', viewedBody)
  assert.equal((await diff()).viewed['context.txt'], viewedBody.hash)
  write('context.txt', modified.replace('line 90\n', 'updated 90\n'))
  const a = await diff()
  assert.deepEqual(a.viewed, {})
  assert.ok(a.comments.find((comment) => comment.start === 90)?.stale)
  for (const comment of saved) {
    await json(goBase() + `comments?id=${comment.id}`, 'DELETE')
  }
  assert.deepEqual((await diff()).comments, [])
  await json(goBase() + 'viewed', 'POST', { range: data.range, clear: true })
  write('context.txt', modified)
  check('Anchors on both sides, context, edits, deletion, stale comments and Viewed')

  const html = await (await fetch(go.url)).text()
  assert.ok(html.includes('<html'))
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    const response: Response = await fetch(`http://127.0.0.1:${go.port}${match[1]}`)
    assert.equal(response.status, 200)
    assert.ok((await response.arrayBuffer()).byteLength > 100)
  }
  assert.equal(
    existsSync(join(repo, '.git', production ? 'ghl' : 'ghl-go-poc', 'state.json')),
    true,
  )
  assert.equal(
    existsSync(join(repo, '.git', production ? 'ghl-go-poc' : 'ghl-go', 'state.json')),
    false,
  )
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
    assert.equal(
      await page.$eval('.product-name', (el) => el.textContent),
      production ? 'ghl' : 'ghl Go PoC',
    )
    for (const selector of ['button.ref.base', 'button.ref.target', '.commit-group']) {
      assert.equal(Boolean(await page.$(selector)), production)
    }
    assert.equal((await page.$('input.untracked')) !== null, production)
    for (const key of ['b', 't', 'l'] as const) {
      await page.keyboard.press(key)
      if (production) await page.waitForSelector('.picker-input')
      assert.equal(Boolean(await page.$('.picker-input')), production)
      if (production) await page.keyboard.press('Escape')
    }
    const shortcuts = await page.$eval('.shortcuts', (el) => el.textContent ?? '')
    assert.equal(/Choose (base|target|commit)/.test(shortcuts), production)
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
    if (production) {
      const includedURL = () => go!.url + '&untracked'
      await page.goto(includedURL(), { waitUntil: 'networkidle0' })
      await page.click('.view-toggle button:first-child')
      assert.ok(await clickTreeRow(page, 'untracked.txt'))
      await sleep(300)
      const host = `[...document.querySelectorAll('.diff diffs-container')].find(host => host.shadowRoot?.querySelector('[data-title]')?.textContent?.trim() === 'untracked.txt')`
      const untrackedPoint = (await page.evaluate(
        `(() => { const rect = (${host})?.shadowRoot?.querySelector('[data-column-number="1"]')?.getBoundingClientRect(); return rect ? { x: rect.x + 4, y: rect.y + rect.height / 2 } : null })()`,
      )) as { x: number; y: number } | null
      assert.ok(untrackedPoint, 'untracked gutter exists')
      await page.mouse.click(untrackedPoint.x, untrackedPoint.y)
      await page.keyboard.press('c')
      await page.waitForSelector('.comment-composer textarea', { visible: true })
      await page.type('.comment-composer textarea', 'Browser untracked remark')
      const posted = page.waitForResponse(
        (response) =>
          response.url().includes('/api/comments') && response.request().method() === 'POST',
      )
      await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '.comment-composer footer button:last-child',
        )
        button?.click()
      })
      const postResponse = await posted
      assert.equal(postResponse.status(), 200, await postResponse.text())
      await page.waitForNetworkIdle()
      const savedUntracked = (await diff('&untracked')).comments[0]!
      assert.deepEqual(savedUntracked.anchor, ['excluded'])
      await page.evaluate(`(${host})?.querySelector('.viewed-toggle input')?.click()`)
      await page.waitForNetworkIdle()
      await stop(go)
      go = await startServer()
      await page.goto(includedURL(), { waitUntil: 'networkidle0' })
      assert.ok((await diff('&untracked')).viewed['untracked.txt'])
      await page.click('input.untracked')
      await page.waitForNetworkIdle()
      assert.ok(!new URL(page.url()).searchParams.has('untracked'))
      await page.click('.comments-trigger')
      await page.waitForSelector('.comments-panel[open]')
      assert.ok(
        (await page.$eval('.comments-panel', (el) => el.textContent ?? '')).includes(
          'Outside the current diff',
        ),
      )
      await page.click('.comments-panel .comment-menu summary')
      await page.click('.comments-panel .comment-menu-items button:first-child')
      await page.waitForSelector('.panel-editor textarea')
      await page.$eval('.panel-editor textarea', (el) => (el as HTMLTextAreaElement).select())
      await page.type('.panel-editor textarea', 'Edited untracked remark')
      await page.click('.panel-editor button[type="submit"]')
      await page.waitForNetworkIdle()
      const outside = (await diff()).comments
      assert.equal(outside[0]?.body, 'Edited untracked remark')
      assert.deepEqual(outside[0]?.anchor, savedUntracked.anchor)
      const historicalCopy = await page.evaluate(
        `(async () => { let text = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { text = value } } }); document.querySelector('.copy-all').click(); await Promise.resolve(); return text })()`,
      )
      assert.equal(historicalCopy, asMarkdown(outside, { range: data.range }))
      assert.ok(String(historicalCopy).includes('Code is unavailable'))
      await page.click('.comments-panel .comment-menu summary')
      await page.click('.comments-panel .comment-menu-items button:last-child')
      await page.waitForNetworkIdle()
      assert.equal((await diff()).comments.length, 0)
      check(
        'browser untracked: comment, Viewed/restart, URL exclusion, historical copy, edit and delete',
      )
    }
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
  rmSync(temporary, { recursive: true, force: true })
}
