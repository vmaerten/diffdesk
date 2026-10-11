import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { version }: { version: string } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = process.env.RELEASE_TAG
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*)?$/
assert.ok(
  semver.test(version),
  'package.json must contain a release version without build metadata',
)
assert.equal(tag, `v${version}`, 'Release tag must match package.json version')
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert.equal(
  git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`),
  git('rev-parse', 'HEAD'),
  'Release tag must point at the checked-out commit',
)
console.log(`Validated release tag ${tag}`)
