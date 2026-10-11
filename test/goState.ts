import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { resolveComparison } from '../src/comparison.ts'
import { gitDirPath } from '../src/git.ts'
import { putComment, readState, setViewed } from '../src/state.ts'
import { withStateLock } from '../src/stateLock.ts'
import type { Comment, DiffPayload } from '../src/types.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-go-state-')))
const repo = join(root, 'repo')
mkdirSync(repo)
const binary = goBinary()
const workerScript = fileURLToPath(new URL('./stateWorker.ts', import.meta.url))
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const stateFile = join(repo, '.git', 'ghl', 'state.json')
const servers: ChildProcess[] = []
let checks = 0

function command(args: string[]) {
  const result = spawnSync(binary, [...args, '--repo', repo], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, GHL_PORT: '' },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

async function start() {
  const child = spawn(
    binary,
    ['--repo', repo, '--base', 'main', '--json', '--no-open', '--no-daemon', '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GHL_PORT: '' },
    },
  )
  servers.push(child)
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk)
  })
  const lines = createInterface({ input: child.stdout! })
  const timer = setTimeout(() => child.kill('SIGTERM'), 20_000)
  try {
    const first = await Promise.race([
      once(lines, 'line').then(([line]) => String(line)),
      once(child, 'exit').then(() => {
        throw new Error(errors)
      }),
    ])
    return { child, url: JSON.parse(first).url.split('?')[0] as string }
  } finally {
    clearTimeout(timer)
    lines.close()
  }
}

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<T>
}

function worker(name: string) {
  const child = spawn(process.execPath, [workerScript, repo, name], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk)
  })
  return once(child, 'exit').then(([code]) => assert.equal(code, 0, errors))
}

try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  writeFileSync(join(repo, 'context.txt'), 'old\ncontext\n')
  git('add', '.')
  git('commit', '-qm', 'main')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'context.txt'), 'new\ncontext\n')
  git('add', '.')
  git('commit', '-qm', 'feature')
  const seed: Comment = {
    id: 'seed',
    path: 'context.txt',
    side: 'additions',
    start: 1,
    end: 1,
    body: 'Node seed',
    anchor: ['new'],
    range: 'main..feature',
    createdAt: '2020-01-01T00:00:00.000Z',
  }
  await putComment(repo, seed)
  await putComment(repo, { ...seed, id: 'before', side: 'deletions', anchor: ['old'] })
  const comparison = await resolveComparison(repo, { override: 'main' })
  const { payload } = await comparison.display('fixture')
  const hash = payload.files.find((file) => file.path === 'context.txt')!.hash
  await setViewed(repo, { range: 'main..feature', path: 'context.txt', hash, viewed: true })
  await setViewed(repo, {
    range: 'historical..range',
    path: 'binary.bin',
    hash: null,
    viewed: true,
  })
  for (const name of ['node-a', 'node-b', 'go-a', 'go-b'])
    await putComment(repo, { ...seed, id: `delete-${name}` })
  const initial = readFileSync(stateFile, 'utf8')
  // Old prototype data is untouched until explicitly imported.
  for (const name of ['ghl-go', 'ghl-go-poc']) {
    mkdirSync(join(repo, '.git', name))
    writeFileSync(
      join(repo, '.git', name, 'state.json'),
      JSON.stringify({ version: 1, viewed: {}, comments: [{ ...seed, id: name }] }),
    )
  }

  let a = await start()
  let b = await start()
  const first = await request<DiffPayload>(a.url + '/api/diff')
  assert.deepEqual(
    first.comments.map(({ code: _code, stale: _stale, ...comment }) => comment),
    JSON.parse(initial).comments,
  )
  assert.deepEqual(first.viewed, { 'context.txt': hash })
  assert.deepEqual(first.comments.find((c) => c.id === 'before')?.code, ['old'])
  assert.equal(readFileSync(stateFile, 'utf8'), initial, 'reading must not rewrite Node state')
  checks += 4

  const goWriter = async (server: typeof a, name: string) => {
    for (let i = 0; i < 10; i++) {
      await request(server.url + '/api/comments', 'POST', {
        ...seed,
        id: `${name}-${i}`,
        body: name,
      })
      await request(server.url + '/api/viewed', 'POST', {
        range: 'concurrent',
        path: `${name}-${i}`,
        hash: name,
        viewed: true,
      })
      await request(server.url + '/api/comments', 'POST', { ...seed, body: name })
    }
    await request(server.url + `/api/comments?id=delete-${name}`, 'DELETE')
  }
  await Promise.all([worker('node-a'), worker('node-b'), goWriter(a, 'go-a'), goWriter(b, 'go-b')])
  const concurrent = (await readState(repo)).state
  assert.equal(concurrent.comments.length, 42)
  assert.equal(new Set(concurrent.comments.map((c) => c.id)).size, 42)
  assert.equal(Object.keys(concurrent.viewed.concurrent!).length, 40)
  assert.equal(concurrent.comments.find((c) => c.id === 'seed')?.createdAt, seed.createdAt)
  assert.equal(concurrent.comments.find((c) => c.id === 'before')?.side, 'deletions')
  assert.equal(concurrent.viewed['main..feature']?.['context.txt'], hash)
  checks += 6
  await request(a.url + '/api/comments?target=main', 'PATCH', {
    id: 'seed',
    body: 'edited outside diff',
  })
  const edited = (await readState(repo)).state.comments.find((c) => c.id === 'seed')!
  assert.equal(edited.createdAt, seed.createdAt)
  assert.deepEqual(edited.anchor, seed.anchor)
  checks++

  // Restart while the other server stays up; no process-local cache owns state.
  const exited = once(a.child, 'exit')
  a.child.kill('SIGINT')
  await exited
  a = await start()
  const restarted = await request<DiffPayload>(a.url + '/api/diff')
  assert.equal(restarted.comments.length, 42)
  assert.equal(restarted.viewed['context.txt'], hash)
  checks++

  const beforeImport = readFileSync(stateFile)
  const source = join(repo, '.git', 'ghl-go', 'state.json')
  const originalSource = readFileSync(source)
  const imported = command(['--import-state', source, '--json'])
  assert.equal(imported.status, 0, imported.stderr)
  const report = JSON.parse(imported.stdout)
  assert.equal(report.comments, 1)
  assert.deepEqual(readFileSync(report.backup), beforeImport)
  assert.deepEqual(readFileSync(source), originalSource)
  const repeat = command(['--import-state', source, '--json'])
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.deepEqual(JSON.parse(repeat.stdout), { comments: 0, viewed: 0, backup: null })
  const pocSource = join(repo, '.git', 'ghl-go-poc', 'state.json')
  assert.equal(command(['--import-state', pocSource]).status, 0)
  checks += 5
  const conflictFile = join(root, 'conflict.json')
  writeFileSync(
    conflictFile,
    JSON.stringify({ version: 1, viewed: {}, comments: [{ ...seed, body: 'conflict' }] }),
  )
  const beforeConflict = readFileSync(stateFile)
  const conflict = command(['--import-state', conflictFile, '--json'])
  assert.equal(conflict.status, 1)
  assert.equal(conflict.stdout, '')
  assert.match(conflict.stderr, /Import conflict/)
  assert.deepEqual(readFileSync(stateFile), beforeConflict)
  checks++

  const linked = join(root, 'linked')
  git('worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD')
  await withStateLock(repo, () =>
    setViewed(linked, { range: 'main..linked', path: 'context.txt', hash, viewed: true }),
  )
  await putComment(linked, { ...seed, id: 'linked-only', range: 'main..linked' })
  const linkedFile = await gitDirPath(linked, 'ghl/state.json')
  assert.notEqual(linkedFile, stateFile)
  const linkedRead = spawnSync(binary, ['comments', '--repo', linked, '--base', 'main', '--json'], {
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(linkedRead.status, 0, linkedRead.stderr)
  assert.deepEqual(
    JSON.parse(linkedRead.stdout).comments.map((c: { id: string }) => c.id),
    ['linked-only'],
  )
  assert.equal(
    (await readState(repo)).state.comments.some((c) => c.id === 'linked-only'),
    false,
  )
  checks += 3

  // Killing a Node writer closes Git's stdin and releases its prepared lock.
  const crash = spawn(process.execPath, [workerScript, repo, 'crash', 'crash'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const crashed = once(crash, 'exit')
  const output = createInterface({ input: crash.stdout! })
  const timer = setTimeout(() => crash.kill('SIGTERM'), 10_000)
  try {
    await Promise.race([
      once(output, 'line'),
      crashed.then(() => {
        throw new Error('Crash worker did not acquire lock')
      }),
    ])
    crash.kill('SIGKILL')
    await crashed
  } finally {
    clearTimeout(timer)
    output.close()
    if (crash.exitCode === null && crash.signalCode === null) crash.kill('SIGTERM')
  }
  assert.deepEqual(readFileSync(stateFile), beforeConflict)
  const afterCrash = command(['comments', '--base', 'main', '--json'])
  assert.equal(afterCrash.status, 0, afterCrash.stderr)
  assert.deepEqual(
    await readState(repo).then((r) => r.state),
    JSON.parse(beforeConflict.toString()),
  )
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/worktree/ghl-state-lock'), '')
  checks += 3

  const future = '{"version":2,"viewed":{},"comments":[]}'
  writeFileSync(stateFile, future)
  assert.equal(command(['comments', '--base', 'main', '--json']).status, 1)
  await assert.rejects(readState(repo), /Unsupported review state version/)
  assert.equal(readFileSync(stateFile, 'utf8'), future)
  checks += 2
  writeFileSync(stateFile, '{corrupt-one')
  const corrupt = command(['comments', '--base', 'main', '--json'])
  assert.equal(corrupt.status, 0, corrupt.stderr)
  assert.match(corrupt.stderr, /\.corrupt/)
  assert.deepEqual(JSON.parse(corrupt.stdout).comments, [])
  writeFileSync(stateFile, '{corrupt-two')
  const recovered = await readState(repo)
  assert.ok(recovered.notice?.includes('.corrupt'))
  const backups = readdirSync(join(repo, '.git', 'ghl'))
    .filter((file) => file.endsWith('.corrupt'))
    .map((file) => readFileSync(join(repo, '.git', 'ghl', file), 'utf8'))
  assert.deepEqual(backups.toSorted(), ['{corrupt-one', '{corrupt-two'])
  checks += 2
  console.log(
    `Go state: ${checks} checks passed (Node/Go concurrency, imports, worktrees, crashes and rollback schema)`,
  )
} finally {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGINT')
      await exited
    }
  }
  rmSync(root, { recursive: true, force: true })
}
