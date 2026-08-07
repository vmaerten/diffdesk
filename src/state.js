import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { git } from './git.js'

/** Inside `.git`, so it is never committed and dies with the repository. */
async function statePath(repoPath) {
  const gitDir = (await git(repoPath, ['rev-parse', '--git-dir'])).trim()
  const absolute = gitDir.startsWith('/') ? gitDir : `${repoPath}/${gitDir}`
  return `${absolute}/ghl/state.json`
}

export async function readState(repoPath) {
  try {
    return JSON.parse(await readFile(await statePath(repoPath), 'utf8'))
  } catch {
    return { viewed: {} } // missing or unreadable just means nothing is viewed
  }
}

async function writeState(repoPath, state) {
  const file = await statePath(repoPath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2))
}

/**
 * Split a patch per file and hash each section.
 *
 * The diff, not the file: hashing the contents would clear the tick for edits
 * outside the diff, and hashing nothing would leave it on code never re-read.
 */
export function sectionHashes(patch) {
  const hashes = {}
  let path = null
  let section = []

  const flush = () => {
    if (!path) return
    hashes[path] = createHash('sha1').update(section.join('\n')).digest('hex').slice(0, 12)
  }

  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (match) {
      flush()
      path = match[2]
      section = []
    }
    section.push(line)
  }
  flush()

  return hashes
}

/** Viewed entries whose hash still matches the current diff. */
export function pruneStale(viewed, hashes) {
  const live = {}
  for (const [path, hash] of Object.entries(viewed)) {
    if (hashes[path] === hash) live[path] = hash
  }
  return live
}

/** Mark or unmark a file. Viewed against one base means nothing against another. */
export async function setViewed(repoPath, { range, path, hash, viewed }) {
  const state = await readState(repoPath)
  state.viewed ??= {}
  state.viewed[range] ??= {}

  if (viewed) state.viewed[range][path] = hash
  else delete state.viewed[range][path]

  await writeState(repoPath, state)
  return state.viewed[range]
}

export async function clearViewed(repoPath, range) {
  const state = await readState(repoPath)
  state.viewed ??= {}
  state.viewed[range] = {}
  await writeState(repoPath, state)
  return {}
}
