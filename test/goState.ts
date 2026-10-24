import { isolatedGit, serveGo } from './goBinary.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import { createHash } from 'node:crypto'

import type { Comment, DiffPayload, StoredState } from '../src/types.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-go-state-')))
const repo = join(root, 'repo')
mkdirSync(repo)
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: isolatedGit }).trim()
const stateFile = join(repo, '.git', 'ghl', 'state.json')
const servers: Awaited<ReturnType<typeof serveGo>>[] = []
let checks = 0

async function start(repoPath = repo) {
  const server = await serveGo(repoPath, ['--base', 'main'])
  servers.push(server)
  return server
}

const send = (url: string, method = 'GET', body?: unknown) =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })

async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await send(url, method, body)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json() as Promise<T>
}

const readStored = (): StoredState => JSON.parse(readFileSync(stateFile, 'utf8'))

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
    body: 'Version-1 seed',
    anchor: ['new'],
    range: 'main..feature',
    createdAt: '2020-01-01T00:00:00.000Z',
  }
  const patch = execFileSync('git', ['-C', repo, 'diff', '--no-ext-diff', '--no-color', 'main'], {
    encoding: 'utf8',
  })
  const hash = createHash('sha1').update(patch).digest('hex').slice(0, 12)
  mkdirSync(join(repo, '.git', 'ghl'))
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      viewed: {
        'main..feature': { 'context.txt': hash },
        'historical..range': { 'binary.bin': null },
      },
      comments: [
        seed,
        { ...seed, id: 'before', side: 'deletions', anchor: ['old'] },
        ...['go-a', 'go-b', 'go-c', 'go-d'].map((name) => ({ ...seed, id: `delete-${name}` })),
      ],
    }),
  )
  const initial = readFileSync(stateFile, 'utf8')

  let a = await start()
  let b = await start()
  const first = await request<DiffPayload>(a.base + '/api/diff')
  assert.deepEqual(
    first.comments.map(({ code: _code, stale: _stale, ...comment }) => comment),
    JSON.parse(initial).comments,
  )
  assert.deepEqual(first.viewed, { 'context.txt': hash })
  assert.deepEqual(first.comments.find((c) => c.id === 'before')?.code, ['old'])
  assert.equal(readFileSync(stateFile, 'utf8'), initial, 'reading must not rewrite version-1 state')
  checks += 4

  const goWriter = async (server: typeof a, name: string) => {
    for (let i = 0; i < 10; i++) {
      await request(server.base + '/api/comments', 'POST', {
        ...seed,
        id: `${name}-${i}`,
        body: name,
      })
      await request(server.base + '/api/viewed', 'POST', {
        range: 'concurrent',
        path: `${name}-${i}`,
        hash: name,
        viewed: true,
      })
      await request(server.base + '/api/comments', 'POST', { ...seed, body: name })
    }
    await request(server.base + `/api/comments?id=delete-${name}`, 'DELETE')
  }
  await Promise.all([
    goWriter(a, 'go-a'),
    goWriter(b, 'go-b'),
    goWriter(a, 'go-c'),
    goWriter(b, 'go-d'),
  ])
  const concurrent = readStored()
  assert.equal(concurrent.comments.length, 42)
  assert.equal(new Set(concurrent.comments.map((c) => c.id)).size, 42)
  assert.equal(Object.keys(concurrent.viewed.concurrent!).length, 40)
  assert.equal(concurrent.comments.find((c) => c.id === 'seed')?.createdAt, seed.createdAt)
  assert.equal(concurrent.comments.find((c) => c.id === 'before')?.side, 'deletions')
  assert.equal(concurrent.viewed['main..feature']?.['context.txt'], hash)
  checks += 6
  await request(a.base + '/api/comments?target=main', 'PATCH', {
    id: 'seed',
    body: 'edited outside diff',
  })
  const edited = readStored().comments.find((c) => c.id === 'seed')!
  assert.equal(edited.createdAt, seed.createdAt)
  assert.deepEqual(edited.anchor, seed.anchor)
  checks++

  // Restart while the other server stays up; no process-local cache owns state.
  await a.close()
  a = await start()
  const restarted = await request<DiffPayload>(a.base + '/api/diff')
  assert.equal(restarted.comments.length, 42)
  assert.equal(restarted.viewed['context.txt'], hash)
  checks++

  const linked = join(root, 'linked')
  git('worktree', 'add', '-q', '-b', 'linked', linked, 'HEAD')
  const linkedServer = await start(linked)
  await request(linkedServer.base + '/api/viewed', 'POST', {
    range: 'main..linked',
    path: 'context.txt',
    hash,
    viewed: true,
  })
  await request(linkedServer.base + '/api/comments', 'POST', {
    ...seed,
    id: 'linked-only',
    range: 'main..linked',
  })
  const linkedFile = execFileSync(
    'git',
    ['-C', linked, 'rev-parse', '--git-path', 'ghl/state.json'],
    { encoding: 'utf8' },
  ).trim()
  assert.notEqual(linkedFile, stateFile)
  const linkedRead = await request<DiffPayload>(linkedServer.base + '/api/diff')
  assert.deepEqual(
    linkedRead.comments.map((c) => c.id),
    ['linked-only'],
  )
  assert.equal(
    readStored().comments.some((c) => c.id === 'linked-only'),
    false,
  )
  checks += 3

  const future = '{"version":2,"viewed":{},"comments":[]}'
  writeFileSync(stateFile, future)
  const unsupported = await send(a.base + '/api/diff')
  assert.notEqual(unsupported.status, 200)
  assert.match(await unsupported.text(), /Unsupported review state version/)
  assert.equal(readFileSync(stateFile, 'utf8'), future)
  checks += 2
  // Reads leave a corrupt file in place; the next write moves it aside.
  const write = () =>
    request(a.url + '/api/viewed', 'POST', {
      range: 'corrupt',
      path: 'context.txt',
      hash,
      viewed: true,
    })
  writeFileSync(stateFile, '{corrupt-one')
  const corrupt = await request<DiffPayload>(a.base + '/api/diff')
  assert.match(corrupt.notice ?? '', /\.corrupt/)
  assert.deepEqual(corrupt.comments, [])
  assert.equal(readFileSync(stateFile, 'utf8'), '{corrupt-one')
  await write()
  writeFileSync(stateFile, '{corrupt-two')
  const recovered = await request<DiffPayload>(a.base + '/api/diff')
  assert.match(recovered.notice ?? '', /\.corrupt/)
  await write()
  const backups = readdirSync(join(repo, '.git', 'ghl'))
    .filter((file) => file.endsWith('.corrupt'))
    .map((file) => readFileSync(join(repo, '.git', 'ghl', file), 'utf8'))
  assert.deepEqual(backups.toSorted(), ['{corrupt-one', '{corrupt-two'])
  checks += 3
  console.log(
    `Go state: ${checks} checks passed (Go process concurrency, worktrees and schema compatibility)`,
  )
} finally {
  await Promise.all(servers.map((server) => server.close()))
  rmSync(root, { recursive: true, force: true })
}
