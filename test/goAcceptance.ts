import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
assert.equal(process.platform, 'darwin', 'Initial release target is macOS ARM64')
assert.equal(process.arch, 'arm64', 'Acceptance must run on the supported native target')
const dist = join(root, 'go/dist/release')
const { version } = JSON.parse(readFileSync(join(dist, 'metadata.json'), 'utf8'))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ghl-release-acceptance-')))
try {
  // Verify shape/checksums before extraction or execution, even when invoked alone.
  execFileSync(process.execPath, ['test/goRelease.ts'], { cwd: root, stdio: 'inherit' })
  execFileSync('tar', ['-xzf', join(dist, `ghl_${version}_darwin_arm64.tar.gz`), '-C', temporary])
  const onlyGit = join(temporary, 'path')
  mkdirSync(onlyGit)
  symlinkSync(
    execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim(),
    join(onlyGit, 'git'),
  )
  const env = {
    ...process.env,
    GHL_TEST_BINARY: join(temporary, 'ghl'),
    GHL_TEST_GIT_PATH: onlyGit,
    GHL_TEST_VERSION: version,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const suites = [
    ['test/goCLI.ts'],
    ['test/goState.ts'],
    ['test/goDaemon.ts'],
    ['test/goPoc.ts', 'go'],
    ['test/goRevisions.ts'],
    ['test/goImages.ts'],
    ['test/run.ts', '--go'],
  ]
  const benchmark = process.argv.includes('--bench')
  for (const args of benchmark ? [] : suites) {
    console.log(`\nRelease acceptance: ${args.join(' ')}`)
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      timeout: 10 * 60_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `Acceptance failed: ${args.join(' ')}`)
  }
  if (benchmark) {
    const result = spawnSync('python3', ['scripts/bench-runtime/run.py', '--go'], {
      cwd: root,
      env: { ...env, BENCH_GHL_GO: env.GHL_TEST_BINARY },
      stdio: 'inherit',
      timeout: 10 * 60_000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'Production runtime benchmark failed')
  } else console.log('\nRelease acceptance passed against the extracted archive executable')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
