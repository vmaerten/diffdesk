import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'ghl-release-guards-'))
const source = join(root, 'go/dist/release')
const validator = join(root, 'test/goRelease.ts')
const tagValidator = join(root, 'scripts/release-tag.ts')
const archiveName = readdirSync(source).find((name) => name.endsWith('.tar.gz'))
assert.ok(archiveName, 'Build a snapshot before exercising release guards')
let checks = 0
function fixture(name: string) {
  const path = join(temporary, name)
  mkdirSync(path)
  for (const file of [archiveName!, 'metadata.json', 'checksums.txt'])
    copyFileSync(join(source, file), join(path, file))
  return path
}
function reject(path: string, expected: RegExp) {
  const result = spawnSync(process.execPath, [validator, path], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, expected)
  checks++
}
try {
  const corrupt = fixture('corrupt-checksum')
  writeFileSync(join(corrupt, 'checksums.txt'), `${'0'.repeat(64)}  ${archiveName}\n`)
  reject(corrupt, /AssertionError/)
  const wrongCommit = fixture('wrong-commit')
  const metadata = JSON.parse(readFileSync(join(wrongCommit, 'metadata.json'), 'utf8'))
  metadata.commit = '0'.repeat(40)
  writeFileSync(join(wrongCommit, 'metadata.json'), JSON.stringify(metadata))
  reject(wrongCommit, /AssertionError/)

  for (const symlink of [false, true]) {
    const path = fixture(symlink ? 'symlink' : 'extra-file')
    const contents = join(path, 'contents')
    mkdirSync(contents)
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt'])
      writeFileSync(join(contents, file), 'fixture')
    const names = ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'ghl']
    if (symlink) execFileSync('ln', ['-s', 'LICENSE', join(contents, 'ghl')])
    else {
      writeFileSync(join(contents, 'ghl'), 'fixture')
      writeFileSync(join(contents, 'loose-asset.js'), 'fixture')
      names.push('loose-asset.js')
    }
    const archive = join(path, archiveName!)
    execFileSync('tar', ['-czf', archive, '-C', contents, ...names])
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
    writeFileSync(join(path, 'checksums.txt'), `${hash}  ${archiveName}\n`)
    reject(path, symlink ? /Only regular archive files/ : /No toolchains, node_modules/)
  }

  // Tags exist only in this temporary repository, never in the user's checkout.
  const repo = join(temporary, 'tag-fixture')
  mkdirSync(repo)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { env, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  git('add', '.')
  git('commit', '-qm', 'release fixture')
  git('tag', 'v1.2.3')
  const runTag = (tag: string) =>
    spawnSync(process.execPath, [tagValidator], {
      cwd: repo,
      env: { ...env, RELEASE_TAG: tag },
      encoding: 'utf8',
    })
  assert.equal(runTag('v1.2.3').status, 0)
  assert.equal(runTag('v1.2.4').status, 1)
  checks += 2
  git('commit', '--allow-empty', '-qm', 'later commit')
  assert.match(runTag('v1.2.3').stderr, /Release tag must point at the checked-out commit/)
  checks++
  for (const version of ['1.2.3-beta.1', '1.2.3-0']) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version }))
    git('tag', `v${version}`)
    assert.equal(runTag(`v${version}`).status, 0)
    checks++
  }
  for (const version of ['01.2.3', '1.2.3-01', '1.2.3+build', 'not-a-version']) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ version }))
    assert.match(runTag(`v${version}`).stderr, /package.json must contain a release version/)
    checks++
  }
  console.log(
    `Release guards: ${checks} checks passed (corruption, archive shape, symlinks and version-tag validation)`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
