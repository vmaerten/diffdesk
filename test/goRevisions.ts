import { loopbackURL } from './system.ts'
import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { launch } from 'puppeteer-core'

import type { DiffPayload, DiffFiles } from '../src/types.ts'
import { createFixture } from './fixture.ts'
import { installDesktopRuntime, serveDesktopUI } from './desktopRuntime.ts'
import { findChrome, sleep, type Harness } from './harness.ts'
import pickers from './suites/pickers.ts'
import commits from './suites/commits.ts'
import stack from './suites/stack.ts'
import untracked from './suites/untracked.ts'

// Keep fixture dates deterministic.
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
const binary = goBinary()
let child: ChildProcess | undefined
let browser: Awaited<ReturnType<typeof launch>> | undefined
let ui: Awaited<ReturnType<typeof serveDesktopUI>> | undefined
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
  child = spawn(
    binary,
    ['--repo', repo, '--base', 'HEAD', '--no-open', '--no-daemon', '--port', '0', '--json'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
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
  const goURL = loopbackURL(announcement.url).href.split('?')[0]!

  const review = async (query = '') => {
    const payload = await json<DiffPayload>(goURL + '/api/diff' + query)
    const expected = execFileSync(
      'git',
      [
        '-C',
        repo,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        payload.comparison.before,
        ...(payload.comparison.after ? [payload.comparison.after] : []),
      ],
      { encoding: 'utf8' },
    )
    assert.equal(payload.patch, expected, query || 'automatic checkout')
    assert.equal(payload.totals.files, payload.files.length)
    checks++
    return payload
  }
  await review()
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
    await review(query)
  const refs = await json<{ refs: { name: string }[] }>(goURL + '/api/refs')
  assert.ok(refs.refs.length > 0)
  const listed = await json<{ commits: { sha: string }[] }>(
    goURL + '/api/commits?target=feature&base=feature%5E',
  )
  assert.equal(listed.commits.length, 1)
  assert.equal(listed.commits[0]?.sha, git('rev-parse', 'feature'))
  console.log(
    '  ok automatic bases, fresh/sibling branches, explicit bases, stacks and refs/commits contracts',
  )

  git('checkout', '-qb', 'guessed/top', 'feature')
  writeFileSync(join(repo, 'top.txt'), 'one more layer\n')
  git('add', 'top.txt')
  git('commit', '-qm', 'guessed top')
  git('checkout', '-q', 'main')
  const guessed = await review('?target=guessed%2Ftop')
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
  for (const ref of [root, merge, empty, 'feature~2']) await review(`?target=feature&commit=${ref}`)
  const merged = await review(`?commit=${merge}`)
  assert.equal(merged.comparison.before, git('rev-parse', merge + '^1'))
  assert.equal(merged.commit?.parents.length, 2)
  await review('?target=feature&commit=missing-commit')
  console.log(
    '  ok guessed parents, arbitrary revisions, root/merge/empty commits and missing-commit fallback contracts',
  )

  const query = '?target=feature&commit=feature~2'
  const selected = await review(query)
  const file = selected.files.find((entry) => entry.path === 'src/core/engine.ts')!
  const contextQuery =
    query +
    '&path=' +
    encodeURIComponent(file.path) +
    '&hash=' +
    file.hash +
    '&comparison=' +
    encodeURIComponent(JSON.stringify(selected.comparison))
  const goFiles = await json<DiffFiles>(goURL + '/api/diff-files' + contextQuery)
  assert.ok(goFiles.oldFile)
  assert.equal(
    goFiles.oldFile.contents,
    execFileSync('git', ['-C', repo, 'show', `${selected.comparison.before}:${file.path}`], {
      encoding: 'utf8',
    }),
  )
  assert.equal(
    goFiles.newFile.contents,
    execFileSync('git', ['-C', repo, 'show', `${selected.comparison.after}:${file.path}`], {
      encoding: 'utf8',
    }),
  )
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
    const result = await json<{ comment: { anchor: string[]; code: string[]; stale: boolean } }>(
      goURL + '/api/comments' + query,
      body,
    )
    const expected = (side === 'additions' ? goFiles.newFile : goFiles.oldFile)!.contents
      .split('\n')
      .slice(0, 2)
    assert.deepEqual(result.comment.anchor, expected)
    assert.deepEqual(result.comment.code, expected)
    assert.equal(result.comment.stale, false)
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
    '  ok selected-commit context and both anchor sides match Git; Viewed stays keyed on the commit',
  )

  writeFileSync(join(repo, 'README.md'), 'working tree change\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged change\n')
  git('add', 'staged.txt')
  await review()
  await review('?committed')
  await review('?target=feature')
  git('stash', 'push', '-qm', 'fixture working tree')
  git('checkout', '--detach', '-q', 'feature')
  await review()
  await review('?base=release')
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
  assert.equal((await review('?target=feature')).base.source, 'remembered')
  assert.equal((await review()).base.ref, 'main')
  assert.equal((await review('?target=feature&base=main')).base.source, 'override')
  git('config', '--unset', 'branch.feature.ghlBase')
  console.log(
    '  ok staged/unstaged scope, detached HEAD, invalid targets and branch-specific base persistence contracts',
  )

  browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  const page = await browser.newPage()
  await installDesktopRuntime(page)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  const goOrigin = new URL(goURL).origin
  ui = await serveDesktopUI(goOrigin)
  const reviewURL = ui.origin + goURL.slice(goOrigin.length)
  const harness: Harness = {
    page,
    repoPath: repo,
    errors: pageErrors,
    url: (selectionQuery) => reviewURL + (selectionQuery ?? '?target=feature'),
    load: async (selectionQuery) => {
      await page.goto(reviewURL + (selectionQuery ?? '?target=feature'), {
        waitUntil: 'networkidle0',
      })
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
    console.log(`  ok existing UI suite against Go: ${suite.name}`)
  }
  assert.deepEqual(pageErrors, [])
  console.log(`  ok ${checks} revision contracts and browser checks`)
} finally {
  await browser?.close()
  await ui?.close()
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
  fixture.cleanup()
}
