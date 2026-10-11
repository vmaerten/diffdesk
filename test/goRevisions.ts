import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import type { DiffPayload, DiffFiles } from '../src/types.ts'
import { createFixture } from './fixture.ts'
import { findChrome, sleep, type Harness } from './harness.ts'
import pickers from './suites/pickers.ts'
import commits from './suites/commits.ts'
import stack from './suites/stack.ts'
import untracked from './suites/untracked.ts'

// Relative Git dates must not cross a second between the two API requests.
const commitDates = {
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
}
const fixture = (() => {
  const previous = {
    GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
    GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
  }
  Object.assign(process.env, commitDates)
  try {
    return createFixture()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})()
const repo = realpathSync(fixture.path)
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...commitDates },
  }).trim()
const node = createGhlServer({ repos: [{ repoPath: repo }] })
const binary = fileURLToPath(new URL('../go/dist/ghl', import.meta.url))
let child: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof launch>> | undefined
let checks = 0

async function json<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<T>
}

try {
  const nodePort = await listen(node, 0)
  const nodeURL = `http://127.0.0.1:${nodePort}/r/${repoIdFor(repo)}`
  child = spawn(binary, ['--repo', repo, '--base', 'HEAD', '--no-open', '--json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk)
  })
  const lines = createInterface({ input: child.stdout! })
  const startupTimer = setTimeout(() => child!.kill('SIGTERM'), 20_000)
  let announcement: { url: string }
  try {
    const raw = await Promise.race([
      once(lines, 'line').then(([line]) => String(line)),
      once(child, 'exit').then(() => {
        throw new Error(`Go startup failed: ${errors}`)
      }),
    ])
    announcement = JSON.parse(raw)
  } finally {
    clearTimeout(startupTimer)
    lines.close()
  }
  const goURL = announcement.url.split('?')[0]!

  const parity = async (query = '') => {
    const [a, b] = await Promise.all([
      json<DiffPayload>(nodeURL + '/api/diff' + query),
      json<DiffPayload>(goURL + '/api/diff' + query),
    ])
    for (const key of [
      'comparison',
      'base',
      'head',
      'target',
      'commit',
      'range',
      'files',
      'totals',
      'patch',
      'notice',
      'untracked',
      'untrackedIncluded',
    ] as const) {
      assert.deepEqual(b[key], a[key], `${query || 'automatic checkout'}: ${key}`)
    }
    checks++
    return b
  }
  await parity()
  git('branch', 'fresh', 'main')
  for (const query of [
    '?target=fresh',
    '?target=other',
    '?target=feature',
    '?target=feature&committed',
    '?target=stack%2Fb',
    '?target=stack%2Fc',
    '?target=feature&base=release',
  ])
    await parity(query)
  assert.deepEqual(await json(goURL + '/api/refs'), await json(nodeURL + '/api/refs'))
  assert.deepEqual(
    await json(goURL + '/api/commits?target=feature&base=feature%5E'),
    await json(nodeURL + '/api/commits?target=feature&base=feature%5E'),
  )
  console.log(
    '  ok automatic bases, fresh/sibling branches, explicit bases, stacks and refs/commits parity',
  )

  git('checkout', '-qb', 'guessed/top', 'feature')
  writeFileSync(join(repo, 'top.txt'), 'one more layer\n')
  git('add', 'top.txt')
  git('commit', '-qm', 'guessed top')
  git('checkout', '-q', 'main')
  const guessed = await parity('?target=guessed%2Ftop')
  assert.equal(guessed.base.source, 'guessed')
  assert.equal(guessed.base.ref, 'feature')
  assert.equal(guessed.base.distance, 1)
  git('checkout', '-qb', 'merged', 'feature')
  git('merge', '-q', '--no-ff', 'other', '-m', 'merge sibling')
  const merge = git('rev-parse', 'HEAD')
  git('commit', '-q', '--allow-empty', '-m', 'empty commit')
  const empty = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  const root = git('rev-list', '--max-parents=0', 'main')
  for (const ref of [root, merge, empty, 'feature~2']) await parity(`?target=feature&commit=${ref}`)
  const merged = await parity(`?commit=${merge}`)
  assert.equal(merged.comparison.before, git('rev-parse', merge + '^1'))
  assert.equal(merged.commit?.parents.length, 2)
  await parity('?target=feature&commit=missing-commit')
  assert.deepEqual(
    await json(goURL + '/api/commits?target=merged&base=release'),
    await json(nodeURL + '/api/commits?target=merged&base=release'),
  )
  console.log(
    '  ok guessed parents, arbitrary revisions, root/merge/empty commits and missing-commit fallback parity',
  )

  const query = '?target=feature&commit=feature~2'
  const selected = await parity(query)
  const file = selected.files.find((entry) => entry.path === 'src/core/engine.ts')!
  const contextQuery =
    query +
    '&path=' +
    encodeURIComponent(file.path) +
    '&hash=' +
    file.hash +
    '&comparison=' +
    encodeURIComponent(JSON.stringify(selected.comparison))
  const [nodeFiles, goFiles] = await Promise.all([
    json<DiffFiles>(nodeURL + '/api/diff-files' + contextQuery),
    json<DiffFiles>(goURL + '/api/diff-files' + contextQuery),
  ])
  assert.deepEqual(
    goFiles.oldFile,
    nodeFiles.oldFile && {
      name: nodeFiles.oldFile.name,
      contents: nodeFiles.oldFile.contents,
      cacheKey: nodeFiles.oldFile.cacheKey,
    },
  )
  assert.deepEqual(goFiles.newFile, {
    name: nodeFiles.newFile.name,
    contents: nodeFiles.newFile.contents,
    cacheKey: nodeFiles.newFile.cacheKey,
  })
  for (const side of ['additions', 'deletions'] as const) {
    const body = {
      id: side,
      path: file.path,
      side,
      start: 1,
      end: 2,
      range: selected.range,
      body: 'commit anchor',
    }
    const [a, b] = await Promise.all([
      json<{ comment: { anchor: string[]; code: string[]; stale: boolean } }>(
        nodeURL + '/api/comments' + query,
        body,
      ),
      json<{ comment: { anchor: string[]; code: string[]; stale: boolean } }>(
        goURL + '/api/comments' + query,
        body,
      ),
    ])
    assert.deepEqual(b.comment.anchor, a.comment.anchor)
    assert.deepEqual(b.comment.code, a.comment.code)
    assert.equal(b.comment.stale, a.comment.stale)
  }
  await json(goURL + '/api/viewed' + query, {
    range: selected.range,
    path: file.path,
    hash: file.hash,
    viewed: true,
  })
  assert.ok(
    (await json<DiffPayload>(goURL + '/api/diff?base=release&target=feature&commit=feature~2'))
      .viewed[file.path],
  )
  assert.equal(
    (await json<DiffPayload>(goURL + '/api/diff?target=feature')).viewed[file.path],
    undefined,
  )
  // Leave the browser suites with fresh review state.
  await json(goURL + '/api/viewed', { range: selected.range, clear: true })
  for (const id of ['additions', 'deletions'])
    assert.equal((await fetch(goURL + '/api/comments?id=' + id, { method: 'DELETE' })).status, 200)
  console.log(
    '  ok selected-commit context and both anchor sides match Node; Viewed stays keyed on the commit',
  )

  writeFileSync(join(repo, 'README.md'), 'working tree change\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged change\n')
  git('add', 'staged.txt')
  await parity()
  await parity('?committed')
  await parity('?target=feature')
  git('stash', 'push', '-qm', 'fixture working tree')
  git('checkout', '--detach', '-q', 'feature')
  await parity()
  await parity('?base=release')
  assert.equal(
    (
      await fetch(goURL + '/api/base', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ base: 'main' }),
      })
    ).status,
    422,
  )
  git('checkout', '-q', 'main')
  const invalid = await fetch(goURL + '/api/diff?target=missing')
  assert.equal(invalid.status, 422)
  await json(goURL + '/api/base', { base: 'release', target: 'feature' })
  assert.equal((await parity('?target=feature')).base.source, 'remembered')
  assert.equal((await parity()).base.ref, 'main')
  assert.equal((await parity('?target=feature&base=main')).base.source, 'override')
  git('config', '--unset', 'branch.feature.ghlBase')
  console.log(
    '  ok staged/unstaged scope, detached HEAD, invalid targets and branch-specific base persistence parity',
  )

  browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  const harness: Harness = {
    page,
    repoPath: repo,
    errors: pageErrors,
    url: (selectionQuery) => goURL + (selectionQuery ?? '?target=feature'),
    load: async (selectionQuery) => {
      await page.goto(goURL + (selectionQuery ?? '?target=feature'), { waitUntil: 'networkidle0' })
      await page.waitForSelector('file-tree-container')
      await sleep(500)
    },
  }
  const check = (name: string, ok: boolean, detail?: string) => {
    assert.ok(ok, `${name}: ${detail ?? ''}`)
    checks++
  }
  for (const suite of [pickers, commits, stack, untracked]) {
    await suite.run(harness, check)
    console.log(`  ok existing browser suite against Go: ${suite.name}`)
  }
  assert.deepEqual(pageErrors, [])
  console.log(`  ok ${checks} revision parity and browser checks`)
} finally {
  await browser?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGINT')
    const timer = setTimeout(() => child!.kill('SIGKILL'), 6000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
  await new Promise<void>((done) => node.close(() => done()))
  fixture.cleanup()
}
