#!/usr/bin/env node
import { execFile } from 'node:child_process'

import { repoState, resolveRepoRoot } from '../src/git.js'
import { buildPatch, resolveBase } from '../src/revision.js'
import { createGhlServer, listen, repoIdFor } from '../src/server.js'

const USAGE = `ghl — review the PR you are about to open, without opening it

Usage:
  ghl [options]

Options:
  --base <rev>   Compare against <rev> instead of the guessed base
  --untracked    Include untracked files in the diff (off by default: they are
                 often numerous and unrelated to the change under review)
  --port <n>     Listen on <n> (default: an available port)
  --no-open      Do not open the browser
  --print        Print a summary to stdout and exit, without serving
  -h, --help     Show this help
`

function parseArgs(argv) {
  const options = { open: true, print: false, port: 0, base: null, untracked: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '--untracked') options.untracked = true
    else if (arg === '--print') options.print = true
    else if (arg === '--base') options.base = argv[++i]
    else if (arg === '--port') options.port = Number.parseInt(argv[++i], 10)
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Count files and lines straight from the patch, to sanity-check the git layer. */
function summarise(patch) {
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

const openBrowser = (url) => execFile('open', [url])

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }

  // The only place where the current directory is read: everything downstream
  // takes repoPath as a parameter.
  const repoPath = await resolveRepoRoot(process.cwd())
  const base = await resolveBase(repoPath, { override: options.base })

  if (options.print) {
    const { patch, untracked, untrackedIncluded } = await buildPatch(repoPath, base.ref, {
      includeUntracked: options.untracked,
    })
    const { files, additions, deletions } = summarise(patch)
    const state = await repoState(repoPath)
    const origin = {
      override: 'given on the command line',
      remembered: 'remembered in .git/config',
      guessed: `guessed (stacked branch, ${base.distance} commit(s))`,
      trunk: 'repository trunk',
    }[base.source]

    const lines = [
      `repo      ${repoPath}`,
      `branch    ${base.branch ?? '(detached HEAD)'}`,
      `base      ${base.ref}  — ${origin}`,
      `changes   ${files} file(s), +${additions} -${deletions}`,
      `untracked ${untracked.length} file(s)${untrackedIncluded ? ' (included)' : ' (excluded, use --untracked)'}`,
    ]
    if (state.operation) {
      lines.push(
        `WARNING   ${state.operation} in progress, ${state.conflicted.length} conflicted file(s)`
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  const server = createGhlServer({
    repos: [{ repoPath, baseOverride: options.base, includeUntracked: options.untracked }],
  })
  const port = await listen(server, options.port)
  const url = `http://localhost:${port}/r/${repoIdFor(repoPath)}`

  process.stdout.write(`ghl serving ${repoPath}\n  base ${base.ref} (${base.source})\n  ${url}\n`)
  if (options.open) openBrowser(url)
}

main().catch((error) => {
  process.stderr.write(`ghl: ${error.message}\n`)
  process.exitCode = 1
})
