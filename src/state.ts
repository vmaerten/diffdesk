import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { gitDirPath } from './git.ts'
import type { Comment, StateRead, StoredState, ViewedMap } from './types.ts'

/** Inside `.git`, so it is never committed and dies with the repository. */
const statePath = (repoPath: string) => gitDirPath(repoPath, 'ghl/state.json')

/** What this build writes. Read back, so a future migration can branch on it. */
const VERSION = 1

const empty = (): StoredState => ({ version: VERSION, viewed: {}, comments: [] })

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
    const { version, viewed, comments } = parsed as Partial<StoredState>
    return {
      state: { version: version ?? VERSION, viewed: viewed ?? {}, comments: comments ?? [] },
      notice: null,
    }
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

/**
 * Store a comment, replacing the one with the same id.
 *
 * Upsert rather than separate create and edit paths: the id comes from the
 * client, so a save that is retried after having in fact succeeded rewrites the
 * same entry instead of adding a second one.
 *
 * An edit keeps the original `createdAt`. It is what orders a thread, and taking
 * the new one would send a comment to the bottom of its own thread for having
 * had a typo fixed.
 */
export async function putComment(repoPath: string, comment: Comment): Promise<Comment[]> {
  return serialise(repoPath, async () => {
    const { state } = await readState(repoPath)
    const at = state.comments.findIndex((stored) => stored.id === comment.id)
    const previous = at === -1 ? null : state.comments[at]
    const next = previous ? { ...comment, createdAt: previous.createdAt } : comment
    if (at === -1) state.comments.push(next)
    else state.comments[at] = next
    await writeState(repoPath, state)
    return state.comments
  })
}

export async function removeComment(repoPath: string, id: string): Promise<Comment[]> {
  return serialise(repoPath, async () => {
    const { state } = await readState(repoPath)
    state.comments = state.comments.filter((stored) => stored.id !== id)
    await writeState(repoPath, state)
    return state.comments
  })
}
