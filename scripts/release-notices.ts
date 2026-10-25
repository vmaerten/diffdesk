import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
interface Package {
  name: string
  version: string
  license?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}
const readPackage = (directory: string): Package =>
  JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))

// These npm archives omit notices for code and data vendored by Shiki.
// Review the upstream material again before adding a version of these packages.
const supplemental: Record<string, Record<string, string[]>> = {
  '@shikijs/engine-oniguruma': {
    '4.4.2': ['shiki-oniguruma-4.4.2.LICENSE', 'vscode-oniguruma-1.7.0.NOTICE'],
  },
  '@shikijs/langs': { '4.4.2': ['tm-grammars-1.32.0.NOTICE'] },
  '@shikijs/themes': {
    '4.4.2': ['tm-themes-1.12.3.NOTICE'],
    '4.5.0': ['tm-themes-1.12.12.NOTICE'],
  },
}

function findPackage(from: string, name: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(directory) === directory) return undefined
  }
}

const seen = new Set<string>()
const notices = new Map<string, string>()
function visit(directory: string) {
  if (seen.has(directory)) return
  seen.add(directory)
  const pkg = readPackage(directory)
  const id = `${pkg.name}@${pkg.version}`
  const files = readdirSync(directory)
    .filter((name) => /^(license|licence|copying|notice)([.-]|$)/i.test(name))
    .toSorted()
  let text = files
    .map((name) => `${name}\n\n${readFileSync(join(directory, name), 'utf8').trim()}`)
    .join('\n\n')
  if (!text && pkg.name === 'lru_map') {
    const readme = readFileSync(join(directory, 'README.md'), 'utf8')
    text = readme.slice(readme.indexOf('# MIT license'))
    if (!text.includes('Permission is hereby granted'))
      throw new Error(`Missing MIT license for ${id}`)
  }
  if (!text && id === 'react-remove-scroll-bar@2.3.8') {
    text = readFileSync(
      join(root, 'scripts/licenses/react-remove-scroll-bar-2.3.8.LICENSE'),
      'utf8',
    ).trim()
  }
  if (!pkg.license || !text) throw new Error(`Missing license material for ${id}`)
  const extra = supplemental[pkg.name]
  if (extra) {
    const vendored = extra[pkg.version]
    if (!vendored) throw new Error(`Review vendored license material for ${id}`)
    for (const file of vendored) {
      text += `\n\n${file}\n\n${readFileSync(join(root, 'scripts/licenses', file), 'utf8').trim()}`
    }
  }
  const entry = `${id} (${pkg.license})\n\n${text}`
  const prior = notices.get(id)
  if (prior && prior !== entry) throw new Error(`Conflicting license material for ${id}`)
  notices.set(id, entry)
  const required = new Set(Object.keys(pkg.dependencies ?? {}))
  const dependencies = new Set([
    ...required,
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  for (const name of dependencies) {
    const child = findPackage(directory, name)
    if (child) visit(child)
    else if (required.has(name)) throw new Error(`Missing dependency ${name} of ${id}`)
  }
}
for (const name of Object.keys(readPackage(root).dependencies ?? {})) {
  const directory = findPackage(root, name)
  if (!directory) throw new Error(`Install production dependency ${name} before generating notices`)
  visit(directory)
}
const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim()
const goLicense = readFileSync(join(goRoot, 'LICENSE'), 'utf8').trim()
const contents =
  [
    'ghl third-party notices',
    'These components retain their own licenses. The list covers the installed production JavaScript dependency closure and the Go standard library.',
    `Go standard library\n\n${goLicense}`,
    ...[...notices].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, text]) => text),
  ].join('\n\n' + '='.repeat(72) + '\n\n') + '\n'
const output = resolve(root, '.task/release')
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'THIRD_PARTY_NOTICES.txt'), contents)
console.log(`Release notices: ${notices.size} JavaScript packages and Go standard library`)
