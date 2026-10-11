import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../poc/go', import.meta.url))
const action = process.argv[2]
const args =
  action === 'test'
    ? ['test', '-race', './...']
    : action === 'build'
      ? ['build', '-trimpath', '-ldflags=-s -w', '-o', 'dist/ghl-go-poc', '.']
      : null
if (!args) throw new Error('Expected build or test')
mkdirSync(resolve(directory, 'dist'), { recursive: true })
writeFileSync(resolve(directory, 'assets/.gitkeep'), '')
const result = spawnSync('go', args, {
  cwd: directory,
  env: { ...process.env, ...(action === 'build' ? { CGO_ENABLED: '0' } : {}) },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
