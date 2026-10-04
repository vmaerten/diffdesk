import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from 'puppeteer-core'

import type { DiffPayload } from '../src/types.ts'
import { findChrome } from './harness.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'ghl-dev-test-'))
const checkout = join(temporary, 'development checkout')
const repo = join(temporary, 'review é with spaces')
mkdirSync(checkout)
mkdirSync(repo)
for (const directory of ['go', 'web', 'src']) {
  cpSync(resolve(root, directory), join(checkout, directory), {
    recursive: true,
    filter: (path) =>
      !path.includes('/assets') && !path.includes('/dist') && !path.includes('/node_modules'),
  })
}
for (const path of ['package.json', 'tsconfig.json', 'vite.config.js', 'Taskfile.yml'])
  cpSync(join(root, path), join(checkout, path))
symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir')
// Reuse the installed dependencies without pnpm reinstalling the fixture's symlink.
writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n')
mkdirSync(join(checkout, '.task/bin'), { recursive: true })
symlinkSync(join(root, '.task/bin/air'), join(checkout, '.task/bin/air'))

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.invalid')
git('config', 'commit.gpgsign', 'false')
git('config', 'core.hooksPath', '/dev/null')
writeFileSync(join(repo, 'context.txt'), 'original\nunchanged\n')
git('add', '.')
git('commit', '-qm', 'base')
writeFileSync(join(repo, 'context.txt'), 'modified\nunchanged\n')

async function freePort() {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  )
  return port
}

async function start(port = '0', requestedBackendPort?: number) {
  const backendPort = requestedBackendPort ?? (await freePort())
  const child = spawn(
    'task',
    [
      'dev',
      `REPO=${relative(checkout, repo)}`,
      'OPEN=false',
      `PORT=${port}`,
      `BACKEND_PORT=${backendPort}`,
    ],
    {
      cwd: checkout,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout!.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr!.on('data', (chunk) => {
    output += String(chunk)
  })
  return { child, backendPort, output: () => output }
}

async function waitFor<T>(
  read: () => Promise<T | false>,
  label: string,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== false) return value
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'close')
  process.kill(-child.pid!, 'SIGINT')
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* already stopped */
    }
  }, 12_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}

const running = await start()
let browser: Awaited<ReturnType<typeof launch>> | undefined
let latestPid = 0
let url = ''
try {
  url = await waitFor(
    async () => {
      if (running.child.exitCode !== null) throw new Error(running.output())
      const frontend = running.output().match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]
      const backend = running.output().match(/\{"port":\d+,"repoId":.*\}/)?.[0]
      if (!frontend || !backend) return false
      const announcement: { port: number; url: string } = JSON.parse(backend)
      assert.equal(announcement.port, running.backendPort)
      const review = new URL(announcement.url)
      return new URL(review.pathname + review.search, frontend).href
    },
    'development startup',
    45_000,
  )
  const origin = new URL(url).origin
  const api = new URL(url).pathname + '/api/'
  const dryRun = spawnSync(
    'task',
    ['--dry', 'dev:web', `REPO=${relative(checkout, repo)}`, 'BASE=main'],
    {
      cwd: checkout,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assert.equal(dryRun.status, 0, dryRun.stderr)
  const dryOutput = dryRun.stdout + dryRun.stderr
  assert.ok(
    dryOutput.includes('--open') && dryOutput.includes(`${new URL(url).pathname}?base=main`),
    'Task opens the canonical review URL with the explicit base',
  )
  const health = async () =>
    (await fetch(origin + '/api/health')).json() as Promise<{ pid: number; version: string }>
  const before = await health()
  latestPid = before.pid
  const html = await (await fetch(url)).text()
  assert.ok(html.includes('/@vite/client'), 'Vite serves the live frontend')
  assert.ok(!html.includes('/assets/index-'), 'no embedded production build is required')
  const data: DiffPayload = await (await fetch(origin + api + 'diff')).json()
  assert.equal(data.base.ref, 'main', 'development resolves the base automatically')
  assert.equal(data.base.source, 'trunk')
  assert.ok(!new URL(url).searchParams.has('base'), 'development does not force a base in the URL')
  assert.equal(
    data.repo.path,
    realpathSync(repo),
    'repository paths with spaces and Unicode survive Task',
  )
  const mutate = async (route: string, body: unknown) => {
    const response = await fetch(origin + api + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
  }
  await mutate('comments', {
    id: 'dev-comment',
    path: 'context.txt',
    side: 'additions',
    start: 1,
    end: 1,
    range: data.range,
    body: 'persist across rebuild',
  })
  await mutate('viewed', {
    range: data.range,
    path: 'context.txt',
    hash: data.files[0]!.hash,
    viewed: true,
  })

  browser = await launch({
    executablePath: findChrome(),
    headless: 'shell',
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.product-name')
  await page.evaluate('window.__ghl_dev_marker = 123')
  const appPath = join(checkout, 'web/src/App.tsx')
  const app = readFileSync(appPath, 'utf8')
  assert.ok(app.includes("{GO_POC ? 'ghl Go PoC' : 'ghl'}"))
  writeFileSync(
    appPath,
    app.replace("{GO_POC ? 'ghl Go PoC' : 'ghl'}", "{GO_POC ? 'ghl Go PoC' : 'ghl HMR'}"),
  )
  await page.waitForFunction("document.querySelector('.product-name')?.textContent === 'ghl HMR'")
  assert.equal(
    await page.evaluate('window.__ghl_dev_marker'),
    123,
    'React refresh does not reload the page',
  )
  const cssPath = join(checkout, 'web/src/styles.css')
  writeFileSync(
    cssPath,
    readFileSync(cssPath, 'utf8') + '\n.product-name { outline: 2px solid rgb(12, 34, 56); }\n',
  )
  await page.waitForFunction(
    "getComputedStyle(document.querySelector('.product-name')).outlineColor === 'rgb(12, 34, 56)'",
  )
  assert.equal(
    await page.evaluate('window.__ghl_dev_marker'),
    123,
    'CSS refresh does not reload the page',
  )
  console.log('  ok React/CSS hot reload through Vite without rebuilding embedded assets')

  const commandPath = join(checkout, 'go/internal/app/command.go')
  const command = readFileSync(commandPath, 'utf8')
  writeFileSync(commandPath, command.replace('var version = "dev"', 'var version = "hot-reloaded"'))
  const after = await waitFor(async () => {
    try {
      const h = await health()
      return h.version === 'hot-reloaded' && h.pid !== before.pid ? h : false
    } catch {
      return false
    }
  }, 'Go restart')
  latestPid = after.pid
  assert.equal(
    await page.evaluate('window.__ghl_dev_marker'),
    123,
    'backend restart leaves the frontend running',
  )
  const restored: DiffPayload = await (await fetch(origin + api + 'diff')).json()
  assert.equal(restored.comments[0]?.body, 'persist across rebuild')
  assert.ok(restored.viewed['context.txt'])
  console.log('  ok Go rebuild/restart preserves URL, comments and Viewed')

  writeFileSync(commandPath, command + '\ninvalid go syntax\n')
  await waitFor(async () => running.output().includes('failed to build'), 'build failure')
  const fallback = await waitFor(async () => {
    try {
      const h = await health()
      return h.version === 'hot-reloaded' ? h : false
    } catch {
      return false
    }
  }, 'last successful build after a compile error')
  latestPid = fallback.pid
  writeFileSync(commandPath, command.replace('var version = "dev"', 'var version = "recovered"'))
  latestPid = (
    await waitFor(async () => {
      try {
        const h = await health()
        return h.version === 'recovered' ? h : false
      } catch {
        return false
      }
    }, 'recovery after a compile error')
  ).pid
  console.log('  ok compile errors are visible and saving valid Go recovers')

  const collision = await start(new URL(url).port)
  const collisionDone = once(collision.child, 'close')
  const timer = setTimeout(() => process.kill(-collision.child.pid!, 'SIGKILL'), 15_000)
  const [code] = await collisionDone
  clearTimeout(timer)
  assert.ok(code !== null && code !== 0, collision.output())
  assert.ok(collision.output().includes('already in use'), collision.output())
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${collision.backendPort}/api/health`)
      return false
    } catch {
      return true
    }
  }, 'conflicting frontend start stops its backend')

  const backendCollision = await start('0', running.backendPort)
  const backendCollisionDone = once(backendCollision.child, 'close')
  const backendTimer = setTimeout(
    () => process.kill(-backendCollision.child.pid!, 'SIGKILL'),
    15_000,
  )
  const [backendCode] = await backendCollisionDone
  clearTimeout(backendTimer)
  assert.ok(backendCode !== null && backendCode !== 0, backendCollision.output())
  assert.ok(backendCollision.output().includes('already in use'), backendCollision.output())
  assert.equal(
    (await health()).pid,
    latestPid,
    'a conflicting dev start does not stop the existing backend',
  )
  console.log('  ok port conflicts fail explicitly without touching the active dev session')
} catch (error) {
  console.error(running.output())
  throw error
} finally {
  await browser?.close()
  await stop(running.child)
  if (url) {
    await waitFor(
      async () => {
        try {
          await fetch(url)
          return false
        } catch {
          return true
        }
      },
      'Vite shutdown',
      10_000,
    )
  }
  if (latestPid) {
    await waitFor(
      async () => {
        try {
          process.kill(latestPid, 0)
          return false
        } catch {
          return true
        }
      },
      'Go shutdown',
      10_000,
    )
  }
  rmSync(temporary, { recursive: true, force: true })
}
console.log('  ok Ctrl-C stops Vite, Air and the Go server')
