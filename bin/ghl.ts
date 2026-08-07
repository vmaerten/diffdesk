#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'

import { repoState, resolveRepoRoot } from '../src/git.ts'
import { buildPatch, resolveBase } from '../src/revision.ts'
import { createGhlServer, listenNear, repoIdFor } from '../src/server.ts'
import type { BaseSource } from '../src/types.ts'

/** Also the target of the Vite dev proxy, so `pnpm dev` needs no flag. */
const DEFAULT_PORT = 7777

/** Resolves to the loopback with no /etc/hosts entry and no dnsmasq (RFC 6761). */
const HOSTNAME = 'ghl.localhost'

interface Options {
  open: boolean
  print: boolean
  help: boolean
  port: number
  base: string | null
  untracked: boolean
  target: string | null
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

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    open: true,
    print: false,
    help: false,
    port: env.GHL_PORT ? parsePort(env.GHL_PORT, 'GHL_PORT') : DEFAULT_PORT,
    base: null,
    untracked: false,
    target: null,
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

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env)
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
    if (state.operation) {
      lines.push(
        `WARNING   ${state.operation} in progress, ${state.conflicted.length} conflicted file(s)`,
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  const server = createGhlServer({
    repos: [
      {
        repoPath,
        baseOverride: options.base,
        target: options.target,
        includeUntracked: options.untracked,
      },
    ],
  })
  const [port, host] = await Promise.all([listenNear(server, options.port), displayHost()])
  const url = `http://${host}:${port}/r/${repoIdFor(repoPath)}`

  process.stdout.write(`ghl serving ${repoPath}\n  base ${base.ref} (${base.source})\n  ${url}\n`)
  if (options.open) openBrowser(url)
}

main().catch((error: unknown) => {
  process.stderr.write(`ghl: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
