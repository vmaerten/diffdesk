/**
 * Install `ghl` as a command that no longer needs this checkout.
 *
 * A symlink to `bin/ghl.ts` would be shorter, but it keeps the command tied to
 * the working copy: move the checkout, switch to a branch mid-rewrite, delete
 * it, and the command follows. So this copies instead — and it copies more than
 * the one file, because `bin/ghl.ts` imports `../src/*.ts` and serves
 * `../web-dist`. Those three directories are the whole runtime: nothing here
 * imports anything outside `node:`, so no dependency is installed.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { argv, env, platform, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Overridable so this can be exercised somewhere other than a real home. */
const HOME = env.GHL_HOME ?? join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'ghl')
const BIN_DIR = env.GHL_BIN_DIR ?? join(homedir(), '.local', 'bin')
const LINK = join(BIN_DIR, 'ghl')

/** Everything the command needs at runtime, and nothing else. */
const PARTS = ['bin', 'src', 'web-dist']

const say = (line: string) => stdout.write(`${line}\n`)

function uninstall(): void {
  rmSync(LINK, { force: true })
  rmSync(HOME, { recursive: true, force: true })
  say(`removed ${LINK}`)
  say(`removed ${HOME}`)
}

function install(): void {
  const missing = PARTS.filter((part) => !existsSync(join(ROOT, part)))
  if (missing.includes('web-dist')) {
    throw new Error('web-dist/ is missing — run `pnpm build` first, or use `pnpm install:local`')
  }
  if (missing.length > 0) throw new Error(`missing from the checkout: ${missing.join(', ')}`)

  // Replaced wholesale rather than merged: a stale file left behind from an
  // older layout would be served without ever being noticed.
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  for (const part of PARTS) cpSync(join(ROOT, part), join(HOME, part), { recursive: true })

  // What was installed, since the copy is cut off from git from here on. The
  // running instance compares this to decide whether it is stale, so installing
  // twice from a dirty tree must not produce the same answer twice — the second
  // install would be reported as up to date and the old code kept serving.
  let revision = 'unknown'
  try {
    const git = (args: string[]) =>
      execFileSync('git', ['-C', ROOT, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    revision = git(['rev-parse', '--short', 'HEAD'])
    if (git(['status', '--porcelain'])) revision += `-dirty.${Date.now()}`
  } catch {
    // Installing from a tarball rather than a clone. Not worth failing over.
  }
  writeFileSync(join(HOME, 'INSTALLED'), `${revision} from ${ROOT}\n`)

  mkdirSync(BIN_DIR, { recursive: true })
  rmSync(LINK, { force: true })
  symlinkSync(join(HOME, 'bin', 'ghl.ts'), LINK)

  say(`installed ${revision} to ${HOME}`)
  say(`command    ${LINK}`)

  const path = env.PATH ?? ''
  if (!path.split(':').includes(BIN_DIR)) {
    say('')
    say(`warning: ${BIN_DIR} is not in your PATH — add it, or the command will not be found`)
  }
}

if (platform === 'win32') {
  throw new Error('this installer targets a POSIX layout; on Windows use `pnpm link --global`')
}

if (argv.includes('--uninstall')) uninstall()
else install()
