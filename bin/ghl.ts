#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { repoState, resolveRepoRoot } from '../src/git.ts'
import { buildPatch, resolveBase } from '../src/revision.ts'
import { createGhlServer, listen, listenNear, repoIdFor, type RepoEntry } from '../src/server.ts'
import type { BaseSource } from '../src/types.ts'
import { runtimeRevision } from '../src/version.ts'

/** Also the target of the Vite dev proxy, so `pnpm dev` needs no flag. */
const DEFAULT_PORT = 7777

/** Resolves to the loopback with no /etc/hosts entry and no dnsmasq (RFC 6761). */
const HOSTNAME = 'ghl.localhost'

const DEFAULT_IDLE_MINUTES = 30

/** A daemon that is up answers at once; one that is absent refuses at once. */
const PROBE_TIMEOUT_MS = 300

/** Long enough for a cold Node start on a loaded machine. */
const STARTUP_TIMEOUT_MS = 5_000

interface Options {
  open: boolean
  print: boolean
  help: boolean
  port: number
  base: string | null
  untracked: boolean
  target: string | null
  daemon: boolean
  useDaemon: boolean
  idleMinutes: number
}

interface Health {
  ghl: true
  revision: string
  pid: number
  repos: { id: string; path: string }[]
}

const USAGE = `ghl — review the PR you are about to open, without opening it

Usage:
  ghl [target] [options]

  target         Branch or revision to review. Defaults to the working tree,
                 i.e. the PR you would open from this checkout right now.

Options:
  --base <rev>   Compare against <rev> instead of the guessed base
  --untracked    Include untracked files in the diff (off by default: they are
                 often numerous and unrelated to the change under review)
  --port <n>     Listen on <n>, or on the next free port after it
                 (default: ${DEFAULT_PORT}, or $GHL_PORT; 0 picks any free port)
  --no-open      Do not open the browser
  --print        Print a summary to stdout and exit, without serving
  --no-daemon    Serve from this process and stay in the foreground, instead of
                 handing the repository to the shared one
  --idle <min>   Stop the shared instance after <min> minutes with no tab
                 watching (default: ${DEFAULT_IDLE_MINUTES}; 0 never stops)
  -h, --help     Show this help
`

/** `Number.parseInt` would take `abc` as NaN and hand it straight to listen(). */
function parsePort(value: string, source: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${source} expects a port between 0 and 65535, got: ${value}`)
  }
  return port
}

function parseMinutes(value: string): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`--idle expects a number of minutes, got: ${value}`)
  }
  return minutes
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    open: true,
    print: false,
    help: false,
    port: env.GHL_PORT ? parsePort(env.GHL_PORT, 'GHL_PORT') : DEFAULT_PORT,
    base: null,
    untracked: false,
    target: null,
    daemon: false,
    useDaemon: true,
    idleMinutes: DEFAULT_IDLE_MINUTES,
  }
  const next = (i: number, flag: string): string => {
    const value = argv[i]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('-') && options.target === null) options.target = arg
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--untracked') options.untracked = true
    else if (arg === '--print') options.print = true
    else if (arg === '--base') options.base = next(++i, '--base')
    else if (arg === '--port') options.port = parsePort(next(++i, '--port'), '--port')
    else if (arg === '--no-daemon') options.useDaemon = false
    // Not in the usage: it is how the CLI starts its own background copy.
    else if (arg === '--daemon') options.daemon = true
    else if (arg === '--idle') options.idleMinutes = parseMinutes(next(++i, '--idle'))
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Count files and lines straight from the patch, to sanity-check the git layer. */
function summarise(patch: string): { files: number; additions: number; deletions: number } {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) files++
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { files, additions, deletions }
}

const openBrowser = (url: string) => execFile('open', [url])

/**
 * The hostname to print, checked rather than assumed.
 *
 * `*.localhost` is loopback by spec, but a corporate search domain can still
 * answer for it, and the server only ever binds 127.0.0.1 — so a URL that would
 * not connect must never be the one printed.
 */
async function displayHost(): Promise<string> {
  try {
    const addresses = await lookup(HOSTNAME, { all: true })
    if (addresses.some(({ address }) => address === '127.0.0.1')) return HOSTNAME
  } catch {
    // Unresolvable is one more reason to fall back, not an error to report.
  }
  return '127.0.0.1'
}

const api = (port: number, route: string) => `http://127.0.0.1:${port}/api/${route}`

/** The instance listening on `port`, or null when there is none of ours. */
async function probe(port: number): Promise<Health | null> {
  try {
    const response = await fetch(api(port, 'health'), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const health = (await response.json()) as Health
    return health.ghl === true ? health : null // something else owns the port
  } catch {
    return null
  }
}

async function post(port: number, route: string, body?: unknown): Promise<Response> {
  return fetch(api(port, route), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 10),
  })
}

/** Poll until something of ours answers, whoever ends up winning the port. */
async function waitForDaemon(port: number): Promise<Health> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const health = await probe(port)
    if (health) return health
    await delay(50)
  }
  throw new Error(`nothing answered on port ${port}`)
}

/** Ask the instance on `port` to go, and wait for the port to come free. */
async function stopDaemon(port: number): Promise<void> {
  try {
    await post(port, 'shutdown')
  } catch {
    // It may well die before answering. That is the outcome we asked for.
  }
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await probe(port)) === null) return
    await delay(50)
  }
  throw new Error(`the instance on port ${port} did not stop`)
}

function spawnDaemon(options: Options): void {
  const self = fileURLToPath(import.meta.url)
  const args = [
    self,
    '--daemon',
    '--port',
    String(options.port),
    '--idle',
    String(options.idleMinutes),
  ]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
}

/**
 * The background process itself: serves nothing at first and takes repositories
 * over HTTP, so registering the first one goes through the same path as the
 * hundredth.
 */
async function runDaemon(options: Options): Promise<void> {
  const server = createGhlServer({
    repos: [],
    idleMs: options.idleMinutes * 60_000,
    onStop: () => {
      server.close()
      process.exit(0)
    },
  })

  try {
    // listen(), not listenNear(): a daemon on another port is a daemon nobody
    // would ever find.
    await listen(server, options.port)
  } catch (error) {
    // Two `ghl` started in the same second both spawn one of these. The loser
    // has nothing to say: the winner is about to serve this repository too.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return
    throw error
  }
}

/** Hand `entry` to the shared instance, starting or replacing it as needed. */
async function serveViaDaemon(options: Options, entry: RepoEntry): Promise<string> {
  const ours = runtimeRevision()
  let health = await probe(options.port)
  let inherited: string[] = []

  // Another build owns the port: it runs an older `src/`, so it has to go — but
  // the repositories it was serving have tabs open on them.
  if (health && health.revision !== ours) {
    inherited = health.repos.map((repo) => repo.path)
    await stopDaemon(options.port)
    health = null
  }

  if (!health) {
    spawnDaemon(options)
    await waitForDaemon(options.port)
  }

  // Handed over with default options: a per-repo flag belongs to the invocation
  // that passed it, and that terminal is long gone.
  for (const repoPath of inherited) {
    if (repoPath !== entry.repoPath) await post(options.port, 'repos', { repoPath })
  }

  const response = await post(options.port, 'repos', entry)
  if (!response.ok) {
    throw new Error(`the instance on port ${options.port} refused the repository`)
  }
  return ((await response.json()) as { id: string }).id
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env)
  if (options.daemon) return runDaemon(options)
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  // The only place where the current directory is read: everything downstream
  // takes repoPath as a parameter.
  const repoPath = await resolveRepoRoot(process.cwd())
  const base = await resolveBase(repoPath, { override: options.base, target: options.target })

  if (options.print) {
    const { patch, untracked, untrackedIncluded } = await buildPatch(repoPath, base.ref, {
      target: options.target,
      includeUntracked: options.untracked,
    })
    const { files, additions, deletions } = summarise(patch)
    const state = await repoState(repoPath)
    const origin: Record<BaseSource, string> = {
      override: 'given on the command line',
      remembered: 'remembered in .git/config',
      stack: 'what the gh stack chain says this sits on',
      guessed: `guessed (stacked branch, ${base.distance} commit(s))`,
      trunk: 'repository trunk',
    }

    const lines = [
      `repo      ${repoPath}`,
      `reviewing ${options.target ?? `${base.branch ?? 'HEAD'} + working tree`}`,
      `base      ${base.ref}  — ${origin[base.source]}`,
      `changes   ${files} file(s), +${additions} -${deletions}`,
      `untracked ${untracked.length} file(s)${untrackedIncluded ? ' (included)' : ' (excluded, use --untracked)'}`,
    ]
    const chain = base.stack
    if (chain) {
      const layers = chain.layers.map((layer, index) => {
        const pr = layer.pr ? ` #${layer.pr.number}` : ''
        const label = `${layer.branch}${pr}${layer.merged ? ' (merged)' : ''}`
        return index === chain.current ? `[${label}]` : label
      })
      lines.push(`stack     ${[chain.trunk, ...layers].join(' → ')}`)
    }
    if (state.operation) {
      lines.push(
        `WARNING   ${state.operation} in progress, ${state.conflicted.length} conflicted file(s)`,
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  const entry: RepoEntry = {
    repoPath,
    baseOverride: options.base,
    target: options.target,
    includeUntracked: options.untracked,
  }

  let port = options.port
  let repoId = repoIdFor(repoPath)

  if (options.useDaemon) {
    repoId = await serveViaDaemon(options, entry)
  } else {
    // Foreground: this process is the server, and dies with the terminal.
    port = await listenNear(createGhlServer({ repos: [entry] }), options.port)
  }

  const url = `http://${await displayHost()}:${port}/r/${repoId}`
  process.stdout.write(`ghl serving ${repoPath}\n  base ${base.ref} (${base.source})\n  ${url}\n`)
  if (options.open) openBrowser(url)
}

main().catch((error: unknown) => {
  process.stderr.write(`ghl: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
