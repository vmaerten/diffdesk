import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'ghl-release-tag-'))
const tagValidator = join(root, 'scripts/release-tag.ts')
let checks = 0
try {
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
    `Release tag: ${checks} checks passed (version format, package.json and tagged commit)`,
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
