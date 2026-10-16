import { findExecutable, loopbackURL } from './system.ts'
import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, get as httpGet, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launch } from 'puppeteer-core'
import { findChrome, sleep } from './harness.ts'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-go-daemon-')))
const binary = join(directory, 'ghl')
const upgraded = join(directory, 'ghl-upgraded')
copyFileSync(goBinary(), binary)
copyFileSync(binary, upgraded)
// An appended payload changes executable identity while keeping an executable
// Mach-O/ELF. This also covers changed assets at identical commit metadata.
appendFileSync(upgraded, '\nnew embedded runtime content\n')
const onlyGit = join(directory, 'path')
mkdirSync(onlyGit)
symlinkSync(findExecutable('git'), join(onlyGit, 'git'))
const env = {
  ...process.env,
  PATH: onlyGit,
  GHL_PORT: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}
const execute = promisify(execFile)
const ports = new Set<number>()
const servers: Server[] = []
let checks = 0
const repo = join(directory, 'dépôt with spaces')
const secondRepo = join(directory, 'second')
const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { env, encoding: 'utf8' }).trim()
for (const path of [repo, secondRepo]) {
  mkdirSync(path)
  git(path, 'init', '-b', 'main')
  git(path, 'config', 'user.name', 'Daemon fixture')
  git(path, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(path, 'sample.txt'), 'before\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'initial')
  git(path, 'checkout', '-qb', 'feature')
  writeFileSync(join(path, 'sample.txt'), 'after\n')
  git(path, 'commit', '-qam', 'feature')
}
const worktree = join(directory, 'linked worktree')
git(repo, 'worktree', 'add', '-b', 'linked', worktree, 'feature')
mkdirSync(join(repo, 'subdirectory'))
const alias = join(directory, 'repository-alias')
symlinkSync(repo, alias)

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  ports.add(port)
  return port
}
async function cli(port: number, path = repo, args: string[] = [], executable = binary) {
  const result = await execute(
    executable,
    ['--repo', path, '--port', String(port), '--no-open', '--json', ...args],
    {
      cwd: directory,
      env,
      timeout: 15_000,
    },
  )
  assert.equal(result.stderr, '')
  const data: { port: number; repoId: string; url: string } = JSON.parse(result.stdout)
  ports.add(data.port)
  return data
}
async function json(port: number, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3000),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function gone(port: number) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) })
    } catch {
      return
    }
    await sleep(30)
  }
  throw new Error(`Daemon still listening on ${port}`)
}
async function shutdown(port: number) {
  const health = await json(port, '/api/health')
  await json(port, '/api/shutdown', 'POST', { instance: health.instance })
  await gone(port)
}
async function hostStatus(port: number, host: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpGet(
      { hostname: '127.0.0.1', port, path: '/api/health', headers: { Host: host } },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    request.on('error', reject)
  })
}

try {
  const port = await freePort()
  const first = await cli(port, repo, ['--base', 'main', 'feature', '--idle', '0'])
  const original = await json(port, '/api/health')
  assert.equal(original.runtime, 'go')
  assert.equal(original.protocolVersion, 1)
  assert.equal(original.daemon, true)
  assert.equal(original.ghl, undefined) // Node must never adopt the Go runtime.
  assert.equal(original.repos[0].id, first.repoId)
  assert.equal(original.repos[0].path, realpathSync(repo))
  assert.equal(new URL(first.url).searchParams.get('base'), 'main')
  assert.equal(new URL(first.url).searchParams.get('target'), 'feature')
  assert.equal(
    (await json(port, new URL(first.url).pathname + '/api/diff?base=main&target=feature')).target
      .workingTree,
    false,
  )
  const bare = await json(port, new URL(first.url).pathname + '/api/diff')
  assert.equal(bare.target.workingTree, true)
  checks += 10

  const second = await cli(port, secondRepo)
  await cli(port, alias)
  await cli(port, join(repo, 'subdirectory'))
  const linked = await cli(port, worktree)
  assert.notEqual(linked.repoId, first.repoId)
  const reused = await json(port, '/api/health')
  assert.equal(reused.pid, original.pid)
  assert.equal(reused.instance, original.instance)
  assert.deepEqual(
    reused.repos.map((r: { id: string }) => r.id).toSorted(),
    [first.repoId, second.repoId, linked.repoId].toSorted(),
  )
  assert.deepEqual((await json(port, '/api/repos')).repos, reused.repos)
  checks += 5

  // A launcher exits, including when its controlling session/terminal exits.
  const terminalPort = await freePort()
  const shell = spawn(
    '/bin/sh',
    [
      '-c',
      '"$1" --repo "$2" --port "$3" --no-open --json',
      'ghl-test',
      binary,
      repo,
      String(terminalPort),
    ],
    { cwd: directory, env, stdio: 'ignore', detached: true },
  )
  assert.equal((await once(shell, 'exit'))[0], 0)
  assert.equal((await json(terminalPort, '/api/health')).daemon, true)
  checks += 2

  const reviewRoute = `/r/${first.repoId}/api/diff?base=main&target=feature`
  const beforeUpgrade = await json(port, reviewRoute)
  const hash = beforeUpgrade.files.find((file: { path: string }) => file.path === 'sample.txt').hash
  const { comment: preserved } = await json(
    port,
    `/r/${first.repoId}/api/comments?base=main&target=feature`,
    'POST',
    {
      id: 'preserved-on-upgrade',
      path: 'sample.txt',
      side: 'additions',
      start: 1,
      end: 1,
      range: 'main..feature',
      body: 'persist across executable replacement',
    },
  )
  await json(port, `/r/${first.repoId}/api/viewed`, 'POST', {
    range: 'main..feature',
    path: 'sample.txt',
    hash,
    viewed: true,
  })
  await cli(port, secondRepo, [], upgraded)
  const replacement = await json(port, '/api/health')
  assert.notEqual(replacement.pid, original.pid)
  assert.notEqual(replacement.instance, original.instance)
  assert.notEqual(replacement.revision, original.revision)
  assert.deepEqual(replacement.repos, reused.repos)
  assert.equal((await fetch(loopbackURL(first.url))).status, 200) // Existing bookmark survives upgrade.
  const stale = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    body: JSON.stringify({ instance: original.instance }),
  })
  assert.equal(stale.status, 409)
  assert.equal((await json(port, '/api/health')).pid, replacement.pid)
  checks += 7
  const afterUpgrade = await json(port, reviewRoute)
  assert.deepEqual(
    afterUpgrade.comments.find((comment: { id: string }) => comment.id === preserved.id),
    preserved,
  )
  assert.equal(afterUpgrade.viewed['sample.txt'], hash)
  await json(port, `/r/${first.repoId}/api/comments?id=${preserved.id}`, 'DELETE')
  await json(port, `/r/${first.repoId}/api/viewed`, 'POST', {
    range: 'main..feature',
    path: 'sample.txt',
    hash,
    viewed: false,
  })
  checks += 2

  const simultaneous = await freePort()
  const opened = await Promise.all([
    cli(simultaneous, repo, ['--idle', '0']),
    cli(simultaneous, secondRepo, ['--idle', '0']),
    cli(simultaneous, worktree, ['--idle', '0']),
  ])
  const shared = await json(simultaneous, '/api/health')
  assert.equal(shared.repos.length, 3)
  assert.ok(opened.every((r) => r.port === simultaneous))
  await Promise.all([
    cli(simultaneous, repo, [], upgraded),
    cli(simultaneous, secondRepo, [], upgraded),
  ])
  const concurrentlyUpgraded = await json(simultaneous, '/api/health')
  assert.notEqual(concurrentlyUpgraded.pid, shared.pid)
  assert.equal(concurrentlyUpgraded.repos.length, 3)
  checks += 4

  assert.equal(await hostStatus(port, 'attacker.invalid'), 403)
  assert.equal(await hostStatus(port, `ghl.localhost:${port}`), 200)
  for (const origin of ['null', 'https://attacker.invalid']) {
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/api/repos`, {
          method: 'POST',
          headers: { Origin: origin },
          body: JSON.stringify({ repoPath: repo }),
        })
      ).status,
      403,
    )
    checks++
  }
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/repos`, {
        method: 'POST',
        body: JSON.stringify({ repoPath: 'relative' }),
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/repos`, {
        method: 'POST',
        body: JSON.stringify({ repoPath: '/missing' }),
      })
    ).status,
    422,
  )
  checks += 4

  // A recognizable Node or another protocol is never shut down or adopted.
  for (const health of [
    { ghl: true, revision: 'node', pid: process.pid, repos: [] },
    { ...replacement, protocolVersion: 999 },
    { ...replacement, ghlGoPoc: true },
  ]) {
    let mutations = 0
    const server = createServer((request, response) => {
      if (request.method !== 'GET') mutations++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(health))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await assert.rejects(cli(address.port), /incompatible runtime/)
    assert.equal(mutations, 0)
    assert.equal(server.listening, true)
    checks += 3
  }
  const occupied = createServer((_request, response) => response.end('unrelated'))
  servers.push(occupied)
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
  const occupiedAddress = occupied.address()
  assert.ok(occupiedAddress && typeof occupiedAddress !== 'string')
  await assert.rejects(cli(occupiedAddress.port), /occupied/)
  assert.equal(occupied.listening, true)
  checks += 2

  const foreground = spawn(
    binary,
    ['--repo', repo, '--port', '0', '--no-daemon', '--no-open', '--json'],
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const foregroundExit = once(foreground, 'exit')
  const lines = createInterface({ input: foreground.stdout })
  const foregroundTimeout = setTimeout(() => foreground.kill('SIGTERM'), 15_000)
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      foregroundExit.then(() => {
        throw new Error('Foreground startup failed')
      }),
    ])
    const info = JSON.parse(line)
    ports.add(info.port)
    assert.equal((await json(info.port, '/api/health')).daemon, false)
    await assert.rejects(cli(info.port), /foreground runtime/)
    assert.equal((await json(info.port, '/api/health')).pid, foreground.pid)
    foreground.kill('SIGTERM')
    assert.equal((await foregroundExit)[0], 0)
    await gone(info.port)
    checks += 4
  } finally {
    clearTimeout(foregroundTimeout)
    lines.close()
    if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGTERM')
  }

  const ephemeral = await cli(0, repo, ['--idle', '0'])
  assert.ok(ephemeral.port > 0)
  assert.notEqual(ephemeral.port, port)
  const ephemeralHealth = await json(ephemeral.port, '/api/health')
  assert.notEqual(ephemeralHealth.pid, replacement.pid)
  await shutdown(ephemeral.port)
  checks += 3

  // Do not poll HTTP to wait for idle shutdown: polling itself is activity.
  const idlePort = await freePort()
  await cli(idlePort, repo, ['--idle', '0.015']) // 900 ms.
  await sleep(550)
  await json(idlePort, '/api/heartbeat', 'POST')
  await sleep(550)
  await json(idlePort, '/api/health')
  await sleep(2200)
  await assert.rejects(fetch(`http://127.0.0.1:${idlePort}/api/health`))
  checks += 2

  // CLI options use the environment only when no explicit port is supplied.
  const envPort = await freePort()
  const environmental = await execute(
    binary,
    ['--repo', repo, '--json', '--no-open', '--idle', '0'],
    { env: { ...env, GHL_PORT: String(envPort) }, timeout: 15_000 },
  )
  assert.equal(JSON.parse(environmental.stdout).port, envPort)
  const printed = await execute(binary, ['--repo', repo, '--print'], {
    env: { ...env, GHL_PORT: String(await freePort()) },
    timeout: 15_000,
  })
  assert.ok(printed.stdout.includes('changes   1 file(s)'))
  checks += 2

  await json(port, `/r/${first.repoId}/api/comments?base=main&target=feature`, 'POST', {
    id: 'hostname-copy',
    path: 'sample.txt',
    side: 'additions',
    start: 1,
    end: 1,
    range: 'main..feature',
    body: 'hostname clipboard comment',
  })
  const browser = await launch({
    executablePath: findChrome(),
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  })
  try {
    const page = await browser.newPage()
    const session = await page.createCDPSession()
    for (const url of [
      first.url,
      first.url.replace(new URL(first.url).hostname, 'ghl.localhost'),
    ]) {
      await session.send('Browser.grantPermissions', {
        origin: new URL(url).origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      })
      await page.goto(url, { waitUntil: 'networkidle0' })
      await page.waitForFunction(() =>
        document.querySelector('.diff diffs-container')?.shadowRoot?.textContent?.includes('after'),
      )
      assert.equal(
        await page.evaluate(
          () => window.isSecureContext && typeof navigator.clipboard?.writeText === 'function',
        ),
        true,
      )
      await page.click('.copy-all')
      await page.waitForFunction(() =>
        document.querySelector('.copy-all')?.textContent?.includes('Copied'),
      )
      const markdown = await page.evaluate(() => navigator.clipboard.readText())
      assert.ok(markdown.includes('hostname clipboard comment'))
      assert.ok(markdown.includes('sample.txt'))
      assert.equal(new URL(page.url()).hostname, new URL(url).hostname)
      const heartbeat = page.waitForResponse((response) => response.url().endsWith('/api/health'))
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      assert.equal((await heartbeat).status(), 200)
      checks += 5
    }
  } finally {
    await browser.close()
  }
  console.log(`Go daemon lifecycle: ${checks} checks passed`)
} finally {
  for (const port of ports) {
    try {
      const health = await json(port, '/api/health')
      if (health.ghlGo && health.daemon && health.protocolVersion === 1) await shutdown(port)
    } catch {
      /* Idle shutdown and failed starts have already released the port. */
    }
  }
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
}
