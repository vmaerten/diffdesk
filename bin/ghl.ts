#!/usr/bin/env node
import { execFile } from 'node:child_process'

import { repoState, resolveRepoRoot } from '../src/git.ts'
import { buildPatch, resolveBase } from '../src/revision.ts'
import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import type { BaseSource } from '../src/types.ts'

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
  --port <n>     Listen on <n> (default: an available port)
  --no-open      Do not open the browser
  --print        Print a summary to stdout and exit, without serving
  -h, --help     Show this help
`

function parseArgs(argv: string[]): Options {
  const options: Options = {
    open: true,
    print: false,
    help: false,
    port: 0,
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
    else if (arg === '--port') options.port = Number.parseInt(next(++i, '--port'), 10)
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
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
  const port = await listen(server, options.port)
  const url = `http://localhost:${port}/r/${repoIdFor(repoPath)}`

  process.stdout.write(`ghl serving ${repoPath}\n  base ${base.ref} (${base.source})\n  ${url}\n`)
  if (options.open) openBrowser(url)
}

main().catch((error: unknown) => {
  process.stderr.write(`ghl: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
