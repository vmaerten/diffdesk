import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import type { CommentExport } from '../src/export.ts'
import type { Comment } from '../src/types.ts'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-go-cli-')))
const repo = join(directory, 'repo é')
mkdirSync(repo)
const binary = fileURLToPath(new URL('../go/dist/ghl', import.meta.url))
const nodeCLI = fileURLToPath(new URL('../bin/ghl.ts', import.meta.url))
const env = {
  ...process.env,
  GHL_PORT: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
}
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim()
const write = (path: string, contents: string) => writeFileSync(join(repo, path), contents)
let checks = 0

function cli(runtime: 'go' | 'node', args: string[], cwd = repo, overrides = {}) {
  const result = spawnSync(
    runtime === 'go' ? binary : process.execPath,
    runtime === 'go' ? args : [nodeCLI, ...args],
    {
      cwd,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 20_000,
    },
  )
  assert.ifError(result.error)
  assert.equal(result.signal, null, `CLI did not exit: ${result.stderr}`)
  return result
}

function success(runtime: 'go' | 'node', args: string[]) {
  const result = cli(runtime, args)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return result.stdout
}

function parity(args: string[], json = false) {
  const go = success('go', args)
  const node = success('node', args)
  if (json) assert.deepEqual(JSON.parse(go), JSON.parse(node))
  else assert.equal(go, node)
  checks++
  return go
}

try {
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  // Node's existing patch reader needs unquoted Unicode paths. Separately
  // check Go's quoted-path behavior against the same validated export below.
  git('config', 'core.quotepath', 'false')
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  write('old name é.txt', lines)
  write('unchanged.txt', 'outside comparison\n')
  write('deleted.txt', 'deleted line\n')
  git('add', '.')
  git('commit', '-qm', 'main')
  git('checkout', '-qb', 'feature')
  git('mv', 'old name é.txt', 'renamed name é.txt')
  write('renamed name é.txt', lines.replace('line 10\n', 'committed 10\n'))
  git('rm', '-q', 'deleted.txt')
  git('add', '.')
  git('commit', '-qm', 'first')
  const parent = git('rev-parse', 'HEAD')
  write('added.txt', 'new line\n')
  git('add', '.')
  git('commit', '-qm', 'second')
  git('branch', 'comments')
  write(
    'renamed name é.txt',
    lines.replace('line 10\n', 'committed 10\n').replace('line 80\n', 'working 80\n'),
  )
  write('staged.txt', 'staged line\n')
  git('add', 'staged.txt')
  write('untracked é.txt', 'untracked line\n')

  const comments: Comment[] = []
  const add = (
    id: string,
    path: string,
    side: Comment['side'],
    start: number,
    end: number,
    anchor: string[],
  ) => {
    comments.push({
      id,
      path,
      side,
      start,
      end,
      anchor,
      body: id + '\n\n<markup> & text',
      range: 'historic..range',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
  }
  add('outside', 'unchanged.txt', 'additions', 1, 1, ['outside comparison'])
  add('old-name', 'old name é.txt', 'deletions', 10, 10, ['line 10'])
  add('current', 'renamed name é.txt', 'additions', 10, 10, ['committed 10'])
  add('before', 'renamed name é.txt', 'deletions', 10, 10, ['line 10'])
  add('context', 'renamed name é.txt', 'additions', 90, 91, ['line 90', 'line 91'])
  add('stale', 'renamed name é.txt', 'additions', 80, 80, ['line 80'])
  add('unavailable', 'added.txt', 'deletions', 1, 1, ['historical line'])
  add('deleted', 'deleted.txt', 'deletions', 1, 1, ['deleted line'])
  add('untracked', 'untracked é.txt', 'additions', 1, 1, ['untracked line'])
  const state = JSON.stringify({ version: 1, viewed: {}, comments })
  for (const runtime of ['ghl', 'ghl-go']) {
    mkdirSync(join(repo, '.git', runtime))
    write(`.git/${runtime}/state.json`, state)
  }

  parity(['--print', '--base', 'main'])
  parity(['feature', '--print', '--base', 'main'])
  parity(['--base', 'main', 'HEAD~1', '--print'])
  parity(['refs/heads/comments', '--print', '--base', 'main'])
  parity(['--print'])
  const exported: CommentExport = JSON.parse(parity(['comments', '--base', 'main', '--json'], true))
  assert.equal(exported.range, 'main..feature')
  assert.equal(exported.repo, repo)
  const byID = new Map(exported.comments.map((comment) => [comment.id, comment]))
  assert.equal(byID.has('outside'), false)
  assert.equal(byID.has('old-name'), false)
  assert.deepEqual(byID.get('before')?.code, ['line 10'])
  assert.deepEqual(byID.get('context')?.code, ['line 90', 'line 91'])
  assert.deepEqual(byID.get('stale')?.was, ['line 80'])
  assert.deepEqual(byID.get('stale')?.code, ['working 80'])
  assert.deepEqual(byID.get('untracked')?.code, ['untracked line'])
  assert.deepEqual(byID.get('unavailable')?.code, [])
  checks += 9
  const markdown = parity(['comments', '--base', 'main'])
  assert.ok(markdown.includes('Code is unavailable in the current comparison. Original lines:'))
  assert.ok(markdown.includes('These lines have changed since the remark was written. They read:'))
  checks += 2
  parity(['comments', '--base', 'main', '--json', '--print'], true)
  parity(['comments', 'feature', '--base', 'main'])
  parity(['comments', '--base', 'main', 'feature', '--json'], true)
  parity(['comments', 'refs/heads/comments', '--base', 'main'])
  parity(['comments', 'main', '--base', 'main', '--json'], true)
  parity(['comments', 'main', '--base', 'main'])

  // Each base explanation is part of the printable contract.
  git('config', 'branch.feature.ghlBase', 'main')
  parity(['--print'])
  git('config', '--unset', 'branch.feature.ghlBase')
  git('branch', 'parent', parent)
  assert.ok(parity(['--print']).includes('guessed (stacked branch, 1 commit(s))'))
  write(
    '.git/gh-stack',
    JSON.stringify({
      schemaVersion: 1,
      stacks: [
        {
          trunk: { branch: 'main' },
          branches: [
            {
              branch: 'parent',
              pullRequest: { number: 1, url: 'https://example.invalid/1', merged: false },
            },
            {
              branch: 'feature',
              pullRequest: { number: 2, url: 'https://example.invalid/2', merged: false },
            },
          ],
        },
      ],
    }),
  )
  assert.ok(parity(['--print']).includes('main → parent #1 → [feature #2]'))
  rmSync(join(repo, '.git/gh-stack'))

  // Reading a repository explicitly also works from outside any checkout.
  const explicit = cli('go', ['comments', '--repo', repo, '--base', 'main', '--json'], directory)
  assert.equal(explicit.status, 0, explicit.stderr)
  assert.deepEqual(JSON.parse(explicit.stdout), exported)
  checks++
  for (const args of [
    ['--base', 'absent', '--print'],
    ['absent', '--print'],
    ['--port', 'oops'],
    ['--base'],
    ['one', 'two'],
    ['--unknown'],
    ['--idle', '1'],
    ['--daemon'],
  ]) {
    const result = cli('go', args)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^ghl: /)
    checks++
  }
  for (const [args, cwd, overrides, message] of [
    [['--print'], directory, {}, /Invalid repository/],
    [['--print'], repo, { PATH: '' }, /Git is required/],
    [['--print'], repo, { GHL_PORT: 'oops' }, /GHL_PORT/],
  ] as const) {
    const result = cli('go', [...args], cwd, overrides)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
    checks++
  }
  mkdirSync(join(directory, 'empty'))
  execFileSync('git', ['-C', join(directory, 'empty'), 'init', '-q', '-b', 'main'], { env })
  const empty = cli('go', ['--print'], join(directory, 'empty'))
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /no commit/)
  checks++
  for (const args of [['--help'], ['comments', '--help'], ['--version', '--json']]) {
    const result = cli('go', args, directory, { PATH: '' })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.ok(result.stdout.length > 0)
    checks++
  }

  const holder = createServer()
  await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done))
  try {
    const address = holder.address()
    assert.ok(address && typeof address !== 'string')
    for (const args of [['--print'], ['comments', '--json']]) {
      const result = cli('go', [
        ...args,
        '--base',
        'main',
        '--port',
        String(address.port),
        '--no-daemon',
      ])
      assert.equal(result.status, 0, result.stderr)
      checks++
    }
  } finally {
    await new Promise<void>((done) => holder.close(() => done()))
  }

  // The shipped executable works outside the checkout with only Git in PATH.
  const standalone = join(directory, 'ghl')
  copyFileSync(binary, standalone)
  const gitOnly = join(directory, 'git-only')
  mkdirSync(gitOnly)
  symlinkSync(
    execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
    join(gitOnly, 'git'),
  )
  const autonomous = spawnSync(
    standalone,
    ['comments', '--repo', repo, '--base', 'main', '--json'],
    {
      cwd: directory,
      env: { ...env, PATH: gitOnly },
      encoding: 'utf8',
      timeout: 20_000,
    },
  )
  assert.ifError(autonomous.error)
  assert.equal(autonomous.status, 0, autonomous.stderr)
  assert.deepEqual(JSON.parse(autonomous.stdout), exported)
  checks++

  // CLI selection lives in the opening URL. Clearing it restores defaults.
  const server = spawn(
    binary,
    ['feature', '--repo', repo, '--base', 'main', '--no-open', '--no-daemon', '--json'],
    {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let serverErrors = ''
  server.stderr.on('data', (chunk) => {
    serverErrors += String(chunk)
  })
  const output = createInterface({ input: server.stdout })
  const exited = once(server, 'exit')
  const startupTimeout = setTimeout(() => server.kill('SIGTERM'), 20_000)
  try {
    const announcementLine = await Promise.race([
      once(output, 'line').then(([line]) => String(line)),
      exited.then(() => {
        throw new Error(`Go startup failed: ${serverErrors}`)
      }),
    ])
    clearTimeout(startupTimeout)
    const announcement = JSON.parse(announcementLine)
    const opening = new URL(announcement.url)
    assert.equal(opening.searchParams.get('target'), 'feature')
    assert.equal(opening.searchParams.get('base'), 'main')
    opening.pathname += '/api/diff'
    const selected = await fetch(opening, { signal: AbortSignal.timeout(15_000) }).then((r) =>
      r.json(),
    )
    assert.equal(selected.target.workingTree, false)
    assert.equal(selected.range, 'main..feature')
    opening.search = ''
    const defaults = await fetch(opening, { signal: AbortSignal.timeout(15_000) }).then((r) =>
      r.json(),
    )
    assert.equal(defaults.target.workingTree, true)
    assert.equal(defaults.base.ref, 'parent')
    checks++
  } finally {
    clearTimeout(startupTimeout)
    output.close()
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGINT')
    const [code] = await exited
    assert.equal(code, 0, serverErrors)
    assert.equal(serverErrors, '')
  }

  git('config', 'core.quotepath', 'true')
  assert.deepEqual(JSON.parse(success('go', ['comments', '--base', 'main', '--json'])), exported)
  checks++
  git('config', 'core.quotepath', 'false')

  write('.git/ghl-go/state.json', '{broken')
  const corrupt = cli('go', ['comments', '--base', 'main', '--json'])
  assert.equal(corrupt.status, 0)
  assert.deepEqual(JSON.parse(corrupt.stdout), { repo, range: 'main..feature', comments: [] })
  assert.match(corrupt.stderr, /\.corrupt/)
  assert.equal(
    success('node', ['comments', '--base', 'main', '--json']),
    JSON.stringify(exported, null, 2) + '\n',
  )
  checks++
  console.log(
    `Go CLI: ${checks} checks passed (Node/Go exports, summaries, failures and standalone binary)`,
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
