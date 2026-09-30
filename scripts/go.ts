import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, 'go')
const action = process.argv[2]
const poc = process.argv[3] === 'poc'
if (!['build', 'test', 'vet'].includes(action ?? '') || (process.argv[3] && !poc))
  throw new Error('Expected build, test or vet, optionally followed by poc')

let args: string[]
if (action === 'build') {
  const name = poc ? 'ghl-go-poc' : 'ghl'
  const output = resolve(root, poc ? 'poc/go/dist' : 'go/dist', name)
  mkdirSync(resolve(output, '..'), { recursive: true })
  // Vite cleans its output directory, including the placeholder used by Go tests.
  writeFileSync(resolve(directory, 'cmd', name, 'assets/.gitkeep'), '')
  const manifest: { version: string } = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  )
  const git = (...argv: string[]) =>
    execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
  const commit =
    process.env.GHL_BUILD_COMMIT ??
    `${git('rev-parse', 'HEAD')}${git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : ''}`
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch !== undefined && !/^\d+$/.test(epoch)) throw new Error('Invalid SOURCE_DATE_EPOCH')
  const date = epoch === undefined ? new Date() : new Date(Number(epoch) * 1000)
  const metadata = {
    version: process.env.GHL_BUILD_VERSION ?? manifest.version,
    commit,
    buildDate: date.toISOString(),
  }
  const flags = ['-s', '-w']
  for (const [key, value] of Object.entries(metadata)) {
    if (!value || /\s|['"]/.test(value)) throw new Error(`Invalid build metadata: ${key}`)
    flags.push('-X', `github.com/vmaerten/ghl/internal/app.${key}=${value}`)
  }
  args = ['build', '-trimpath', `-ldflags=${flags.join(' ')}`, '-o', output, `./cmd/${name}`]
} else {
  args = action === 'test' ? ['test', '-race', './...'] : ['vet', './...']
}
const result = spawnSync('go', args, {
  cwd: directory,
  env: { ...process.env, ...(action === 'build' ? { CGO_ENABLED: '0' } : {}) },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
