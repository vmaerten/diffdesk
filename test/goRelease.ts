import { archiveName, releaseTarget, RELEASE_TARGETS } from './releaseTarget.ts'
import { findExecutable, loopbackURL } from './system.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(root, process.argv[2] ?? 'go/dist/release')
interface Metadata {
  project_name: string
  version: string
  commit: string
  tag: string
}
const metadata: Metadata = JSON.parse(readFileSync(join(dist, 'metadata.json'), 'utf8'))
const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
assert.equal(metadata.project_name, 'ghl')
assert.equal(metadata.commit, expectedCommit)
const tag = process.env.RELEASE_TAG
if (tag) {
  assert.equal(metadata.tag, tag)
  assert.equal(metadata.version, tag.slice(1))
}
const selectedTarget = releaseTarget()
const selectedArchive = archiveName(metadata.version, selectedTarget)
const names = RELEASE_TARGETS.map((target) => archiveName(metadata.version, target)).toSorted()
assert.deepEqual(
  readdirSync(dist)
    .filter((name) => name.endsWith('.tar.gz'))
    .toSorted(),
  names,
)
const checksums = readFileSync(join(dist, 'checksums.txt'), 'utf8').trim().split('\n')
assert.equal(checksums.length, names.length, 'Every platform archive must be checksummed')
const hashes = new Map<string, string>()
for (const line of checksums) {
  const match = line.match(
    /^([\da-f]{64})  (ghl_[\w.+-]+_(?:darwin|linux)_(?:arm64|amd64)\.tar\.gz)$/,
  )
  assert.ok(match, 'Expected a portable SHA-256 checksum line')
  assert.ok(!hashes.has(match[2]!), 'Duplicate checksum filename')
  hashes.set(match[2]!, match[1]!)
}
assert.deepEqual([...hashes.keys()].toSorted(), names)
for (const name of names) {
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(dist, name)))
      .digest('hex'),
    hashes.get(name),
    name,
  )
}

const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-release-')))
let server: ReturnType<typeof spawn> | undefined
try {
  for (const target of RELEASE_TARGETS) {
    const archive = join(dist, archiveName(metadata.version, target))
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((name) => name.replace(/^\.\//, ''))
      .toSorted()
    assert.deepEqual(
      members,
      ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'ghl'],
      'No toolchains, node_modules, browser, loose assets or extra files may ship',
    )
    const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(
      entries.every((line) => line.startsWith('-')),
      'Only regular archive files may be extracted',
    )
    const contents = join(temporary, target)
    mkdirSync(contents)
    execFileSync('tar', ['-xzf', archive, '-C', contents])
    for (const member of members) assert.ok(lstatSync(join(contents, member)).isFile())
    const binary = join(contents, 'ghl')
    chmodSync(binary, 0o755)
    assert.equal(
      readFileSync(join(contents, 'LICENSE'), 'utf8'),
      readFileSync(join(root, 'LICENSE'), 'utf8'),
    )
    const notices = readFileSync(join(contents, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const name of [
      'Go standard library',
      '@pierre/diffs@',
      '@pierre/trees@',
      'react@',
      'react-dom@',
      'cmdk@',
      'Permission is hereby granted',
      'Apache License',
      'VS Code Oniguruma Bindings',
      'oniguruma version 6.9.5_rev1',
      'tm-grammars-1.32.0.NOTICE',
      'tm-themes-1.12.3.NOTICE',
    ])
      assert.ok(notices.includes(name), `Archive lacks notice: ${name}`)
    const goMetadata = execFileSync('go', ['version', '-m', binary], { encoding: 'utf8' })
    const [os, arch] = target.split('_')
    for (const setting of ['CGO_ENABLED=0', `GOOS=${os}`, `GOARCH=${arch}`, '-trimpath=true']) {
      assert.ok(goMetadata.includes(setting), `Wrong release setting (${target}): ${setting}`)
    }
  }
  const binary = join(temporary, selectedTarget, 'ghl')
  const onlyGit = join(temporary, 'path')
  mkdirSync(onlyGit)
  const gitBinary = findExecutable('git')
  symlinkSync(gitBinary, join(onlyGit, 'git'))
  const env = {
    ...process.env,
    PATH: onlyGit,
    GHL_PORT: '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const info = JSON.parse(
    execFileSync(binary, ['--version', '--json'], { cwd: temporary, env, encoding: 'utf8' }),
  )
  assert.equal(info.version, metadata.version)
  assert.equal(info.commit, expectedCommit)
  assert.equal(info.runtime, 'go')
  assert.equal(info.protocolVersion, 1)
  const commitDate = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  assert.equal(info.buildDate, new Date(commitDate).toISOString().replace('.000Z', 'Z'))

  const repo = join(temporary, 'review repository')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'sample.txt'), 'after\n')
  git('commit', '-qam', 'review')
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n')
  server = spawn(
    binary,
    ['--repo', repo, '--base', 'main', '--no-daemon', '--port', '0', '--no-open', '--json'],
    { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const child = server
  let errors = ''
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk)
  })
  const exited = once(child, 'exit')
  const output = createInterface({ input: child.stdout! })
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000)
  try {
    const [line] = await Promise.race([
      once(output, 'line'),
      exited.then(() => {
        throw new Error(`Release startup failed: ${errors}`)
      }),
    ])
    const announced: { port: number; repoId: string; url: string } = JSON.parse(line)
    const origin = `http://127.0.0.1:${announced.port}`
    const page = await fetch(loopbackURL(announced.url), { signal: AbortSignal.timeout(3000) })
    assert.equal(page.status, 200)
    assert.ok(page.headers.get('content-type')?.includes('text/html'))
    const html = await page.text()
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!)
    const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((match) => match[1]!)
    assert.ok(scripts.length > 0 && styles.length > 0, 'Embedded HTML must load JavaScript and CSS')
    for (const asset of [...scripts, ...styles]) {
      assert.ok(asset.startsWith('/assets/'))
      const response = await fetch(origin + asset)
      assert.equal(response.status, 200)
      assert.ok((await response.text()).length > 100)
    }
    const health = await (await fetch(origin + '/api/health')).json()
    for (const key of ['version', 'commit', 'buildDate', 'runtime', 'protocolVersion'])
      assert.equal(health[key], info[key])
    assert.equal(health.ghlGoPoc, undefined)
    const comparison = await fetch(`${origin}/r/${announced.repoId}/api/diff?base=main&untracked=1`)
    assert.equal(comparison.status, 200)
    const data = await comparison.json()
    assert.equal(data.untrackedIncluded, true, 'Release must use production capabilities')
    assert.deepEqual(data.files.map((file: { path: string }) => file.path).toSorted(), [
      'sample.txt',
      'untracked.txt',
    ])
    assert.equal(errors, '')
    child.kill('SIGTERM')
    assert.equal((await exited)[0], 0, 'Released binary must shut down cleanly')
  } finally {
    clearTimeout(timer)
    output.close()
  }
  console.log(
    `Release artifact verified: ${selectedArchive} (all four archives checked; standalone API and embedded HTML/JS/CSS executed on ${selectedTarget})`,
  )
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
  }
  rmSync(temporary, { recursive: true, force: true })
}
