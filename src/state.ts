import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { gitDirPath } from './git.ts'
import type { DiffSide, StateRead, StoredState, ViewedMap } from './types.ts'

/** Inside `.git`, so it is never committed and dies with the repository. */
const statePath = (repoPath: string) => gitDirPath(repoPath, 'ghl/state.json')

/** What this build writes. Read back, so a future migration can branch on it. */
const VERSION = 1

const empty = (): StoredState => ({ version: VERSION, viewed: {} })

/**
 * One mutation at a time per repository.
 *
 * Every write is a read-modify-write of the whole file, so two that overlap
 * lose whichever read first. One process serves every repository, so a promise
 * chain per path is enough; `--no-daemon` is the only case it does not cover.
 */
const queues = new Map<string, Promise<unknown>>()

function serialise<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(repoPath) ?? Promise.resolve()
  // Both handlers: one caller's failure must not strand the next in the queue.
  const next = previous.then(work, work)
  queues.set(
    repoPath,
    next.catch(() => {}),
  )
  return next
}

/**
 * The state on disk, and anything reading it had to report.
 *
 * A missing file is the normal first run. A file that is present and
 * unparseable is not: it held something someone wrote, so it moves aside rather
 * than being overwritten, and the caller is told — a state file discarded in
 * silence is how the loss goes unnoticed until it matters.
 */
export async function readState(repoPath: string): Promise<StateRead> {
  const file = await statePath(repoPath)

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { state: empty(), notice: null }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    const { version, viewed } = parsed as Partial<StoredState>
    return { state: { version: version ?? VERSION, viewed: viewed ?? {} }, notice: null }
  } catch {
    const aside = `${file}.corrupt`
    await rename(file, aside).catch(() => {})
    return {
      state: empty(),
      notice: `${file} could not be read and was moved to ${aside}; starting from an empty state`,
    }
  }
}

/**
 * Per write, not per process: two writes sharing a temporary path race on it
 * rather than on the state file, which would make the atomicity here depend on
 * the serialisation above holding.
 */
let writes = 0

async function writeState(repoPath: string, state: StoredState): Promise<void> {
  const file = await statePath(repoPath)
  await mkdir(dirname(file), { recursive: true })
  // Beside it, then rename: a write cut short in place leaves a truncated file,
  // and a truncated file is one that reads as no state at all.
  const temporary = `${file}.${process.pid}.${writes++}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2))
  await rename(temporary, file)
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

/**
 * The text of lines `start`..`end` of one side of a file, as the patch has them.
 *
 * `deletions` counts in the old file, `additions` in the new one — the same
 * coordinates the diff pane reports. Null rather than blanks when any line of
 * the range falls outside the hunks: these patches are partial, so a line the
 * patch does not carry is unknown, not empty.
 */
export function linesAt(
  patch: string,
  { path, side, start, end }: { path: string; side: DiffSide; start: number; end: number },
): string[] | null {
  if (start < 1 || end < start) return null

  const found = new Map<number, string>()
  let inFile = false
  let inHunk = false
  let old = 0
  let now = 0

  for (const line of patch.split('\n')) {
    const file = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (file) {
      if (inFile) break // its section is over, and nothing after it can help
      inFile = file[2] === path
      inHunk = false
      continue
    }
    if (!inFile) continue

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      old = Number(hunk[1])
      now = Number(hunk[2])
      inHunk = true
      continue
    }
    // Before the first hunk sit `--- a/x` and `+++ b/x`, which a removed line
    // reading `--foo` is indistinguishable from once the marker is stripped.
    if (!inHunk) continue

    const text = line.slice(1)
    const at = side === 'additions' ? now : old

    if (line.startsWith('+')) {
      if (side === 'additions' && at >= start && at <= end) found.set(at, text)
      now++
    } else if (line.startsWith('-')) {
      if (side === 'deletions' && at >= start && at <= end) found.set(at, text)
      old++
    } else if (line.startsWith(' ')) {
      if (at >= start && at <= end) found.set(at, text)
      old++
      now++
    }
  }

  const lines: string[] = []
  for (let at = start; at <= end; at++) {
    const text = found.get(at)
    if (text === undefined) return null
    lines.push(text)
  }
  return lines
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
  return serialise(repoPath, async () => {
    const { state } = await readState(repoPath)
    const forRange = (state.viewed[range] ??= {})

    if (viewed) forRange[path] = hash
    else delete forRange[path]

    await writeState(repoPath, state)
    return forRange
  })
}

export async function clearViewed(repoPath: string, range: string): Promise<ViewedMap> {
  return serialise(repoPath, async () => {
    const { state } = await readState(repoPath)
    state.viewed[range] = {}
    await writeState(repoPath, state)
    return {}
  })
}
