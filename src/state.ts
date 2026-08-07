import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { git } from './git.ts'
import type { ViewedMap } from './types.ts'

/** Inside `.git`, so it is never committed and dies with the repository. */
async function statePath(repoPath: string): Promise<string> {
  const gitDir = (await git(repoPath, ['rev-parse', '--git-dir'])).trim()
  const absolute = gitDir.startsWith('/') ? gitDir : `${repoPath}/${gitDir}`
  return `${absolute}/ghl/state.json`
}

export async function readState(repoPath: string): Promise<{ viewed: Record<string, ViewedMap> }> {
  try {
    return JSON.parse(await readFile(await statePath(repoPath), 'utf8'))
  } catch {
    return { viewed: {} } // missing or unreadable just means nothing is viewed
  }
}

async function writeState(repoPath: string, state: unknown): Promise<void> {
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
export function sectionHashes(patch: string): Record<string, string> {
  const hashes: Record<string, string> = {}
  let path: string | null = null
  let section: string[] = []

  const flush = () => {
    if (!path) return
    hashes[path] = createHash('sha1').update(section.join('\n')).digest('hex').slice(0, 12)
  }

  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (match?.[2]) {
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
export function pruneStale(viewed: ViewedMap, hashes: Record<string, string>): ViewedMap {
  const live: ViewedMap = {}
  for (const [path, hash] of Object.entries(viewed)) {
    if (hashes[path] === hash) live[path] = hash
  }
  return live
}

/** Mark or unmark a file. Viewed against one base means nothing against another. */
export async function setViewed(
  repoPath: string,
  {
    range,
    path,
    hash,
    viewed,
  }: { range: string; path: string; hash: string | null; viewed: boolean },
): Promise<ViewedMap> {
  const state = await readState(repoPath)
  state.viewed ??= {}
  const forRange = (state.viewed[range] ??= {})

  if (viewed) forRange[path] = hash
  else delete forRange[path]

  await writeState(repoPath, state)
  return forRange
}

export async function clearViewed(repoPath: string, range: string): Promise<ViewedMap> {
  const state = await readState(repoPath)
  state.viewed ??= {}
  state.viewed[range] = {}
  await writeState(repoPath, state)
  return {}
}
