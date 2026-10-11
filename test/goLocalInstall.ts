import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporary = mkdtempSync(join(tmpdir(), 'ghl-local-install-'))
const bin = join(temporary, 'bin with spaces')
const legacy = join(temporary, 'legacy-node-command')
const nodeHome = join(temporary, 'node runtime')
const state = join(temporary, 'repo/.git/ghl/state.json')
const env = { ...process.env, GHL_BIN_DIR: bin, GHL_HOME: nodeHome }
const run = (command: string, args: string[]) =>
  execFileSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

try {
  mkdirSync(bin)
  mkdirSync(join(temporary, 'repo/.git/ghl'), { recursive: true })
  writeFileSync(state, '{"version":1,"viewed":{"fixture":"hash"},"comments":[]}\n')
  writeFileSync(legacy, 'previous Node installation\n')
  symlinkSync(legacy, join(bin, 'ghl'))

  run('task', ['install', `BIN_DIR=${bin}`])
  assert.equal(lstatSync(join(bin, 'ghl')).isSymbolicLink(), false)
  assert.equal(readFileSync(legacy, 'utf8'), 'previous Node installation\n')
  const metadata = JSON.parse(run(join(bin, 'ghl'), ['--version', '--json']))
  assert.equal(metadata.runtime, 'go')
  assert.equal(JSON.parse(run('task', ['run', '--', '--version', '--json'])).runtime, 'go')
  console.log('ok default Go command, clean JSON stdout and atomic replacement of a Node symlink')

  run('pnpm', ['install:node'])
  assert.equal(lstatSync(join(bin, 'ghl-node')).isSymbolicLink(), true)
  assert.equal(JSON.parse(run(join(bin, 'ghl'), ['--version', '--json'])).runtime, 'go')
  assert.ok(run(join(bin, 'ghl-node'), ['--help']).includes('Usage:'))
  console.log('ok explicit Node fallback does not replace the Go command')

  run('task', ['install', `BIN_DIR=${bin}`])
  assert.equal(JSON.parse(run(join(bin, 'ghl'), ['--version', '--json'])).runtime, 'go')
  run('task', ['uninstall', `BIN_DIR=${bin}`])
  assert.equal(existsSync(join(bin, 'ghl')), false)
  assert.equal(existsSync(join(bin, 'ghl-node')), true)
  assert.equal(
    readFileSync(state, 'utf8'),
    '{"version":1,"viewed":{"fixture":"hash"},"comments":[]}\n',
  )
  run('pnpm', ['uninstall:node'])
  assert.equal(existsSync(nodeHome), false)
  assert.equal(existsSync(join(bin, 'ghl-node')), false)
  assert.equal(readFileSync(legacy, 'utf8'), 'previous Node installation\n')
  console.log('ok reinstall/uninstall preserve review state and the other runtime')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
