import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

import { gitDirPath } from './git.ts'
import type { Comment, StateRead, StoredState, ViewedMap } from './types.ts'
import { withStateLock } from './stateLock.ts'

/** Inside `.git`, so it is never committed and dies with the repository. */
const statePath = (repoPath: string) => gitDirPath(repoPath, 'ghl/state.json')

/** What this build writes. Read back, so a future migration can branch on it. */
const VERSION = 1

const empty = (): StoredState => ({ version: VERSION, viewed: {}, comments: [] })

/**
 * One mutation at a time per repository.
 *
 * Queue in-process work, then hold the same Git transaction lock as Go for the
 * complete read-modify-write. Foreground and CLI processes share that lock.
 */
const queues = new Map<string, Promise<unknown>>()
const pendingNotices = new Map<string, string>()

function serialise<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(repoPath) ?? Promise.resolve()
  // Both handlers: one caller's failure must not strand the next in the queue.
  const locked = () => withStateLock(repoPath, work)
  const next = previous.then(locked, locked)
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
  return serialise(repoPath, async () => {
    const result = await readUnlocked(repoPath)
    const notice = result.notice ?? pendingNotices.get(repoPath) ?? null
    pendingNotices.delete(repoPath)
    return { state: result.state, notice }
  })
}

async function readUnlocked(repoPath: string): Promise<StateRead> {
  const file = await statePath(repoPath)

  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: empty(), notice: null }
    throw error
  }

  try {
    return { state: decodeState(raw), notice: null }
  } catch (error) {
    if (error instanceof UnsupportedStateVersion) throw error
    const aside = `${file}.${Date.now()}.${randomUUID()}.corrupt`
    await rename(file, aside)
    const notice = `${file} could not be read and was moved to ${aside}; starting from an empty state`
    pendingNotices.set(repoPath, notice)
    return { state: empty(), notice }
  }
}

class UnsupportedStateVersion extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Same version-1 validation as Go; future versions fail without moving files. */
function decodeState(raw: string): StoredState {
  const parsed: unknown = JSON.parse(raw)
  if (!isObject(parsed)) throw new Error('Review state must be an object')
  const version = parsed.version ?? VERSION
  if (!Number.isInteger(version)) throw new Error('Invalid review state version')
  if (version !== VERSION)
    throw new UnsupportedStateVersion(
      `Unsupported review state version ${version}; use a compatible runtime. The file was left unchanged`,
    )
  const viewed = parsed.viewed ?? {}
  const comments = parsed.comments ?? []
  if (!isObject(viewed) || !Array.isArray(comments)) throw new Error('Invalid review state')
  for (const entries of Object.values(viewed)) {
    if (
      !isObject(entries) ||
      Object.values(entries).some((hash) => hash !== null && typeof hash !== 'string')
    )
      throw new Error('Invalid Viewed map')
  }
  for (const c of comments) {
    if (
      !isObject(c) ||
      typeof c.id !== 'string' ||
      !c.id ||
      typeof c.path !== 'string' ||
      !c.path ||
      c.path.startsWith('/') ||
      /[\\\0]/.test(c.path) ||
      c.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
      (c.side !== 'additions' && c.side !== 'deletions') ||
      !Number.isSafeInteger(c.start) ||
      !Number.isSafeInteger(c.end) ||
      typeof c.start !== 'number' ||
      typeof c.end !== 'number' ||
      c.start < 1 ||
      c.end < c.start ||
      c.end - c.start >= 20 * 1024 * 1024 ||
      (c.body != null && typeof c.body !== 'string') ||
      !Array.isArray(c.anchor) ||
      c.anchor.some((line) => typeof line !== 'string') ||
      typeof c.range !== 'string' ||
      !c.range ||
      typeof c.createdAt !== 'string' ||
      !c.createdAt
    )
      throw new Error('Invalid comment in review state')
  }
  return { version: VERSION, viewed, comments } as StoredState
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
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(JSON.stringify(state, null, 2))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
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
    const { state } = await readUnlocked(repoPath)
    const forRange = (state.viewed[range] ??= {})

    if (viewed) forRange[path] = hash
    else delete forRange[path]

    await writeState(repoPath, state)
    return forRange
  })
}

export async function clearViewed(repoPath: string, range: string): Promise<ViewedMap> {
  return serialise(repoPath, async () => {
    const { state } = await readUnlocked(repoPath)
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
    const { state } = await readUnlocked(repoPath)
    const at = state.comments.findIndex((stored) => stored.id === comment.id)
    const previous = at === -1 ? null : state.comments[at]
    const next = previous ? { ...comment, createdAt: previous.createdAt } : comment
    if (at === -1) state.comments.push(next)
    else state.comments[at] = next
    await writeState(repoPath, state)
    return state.comments
  })
}

/** Editing prose preserves the original code anchor, even outside the current diff. */
export async function updateCommentBody(
  repoPath: string,
  id: string,
  body: string,
): Promise<Comment | null> {
  return serialise(repoPath, async () => {
    const { state } = await readUnlocked(repoPath)
    const comment = state.comments.find((entry) => entry.id === id)
    if (!comment) return null
    comment.body = body
    await writeState(repoPath, state)
    return comment
  })
}

export async function removeComment(repoPath: string, id: string): Promise<Comment[]> {
  return serialise(repoPath, async () => {
    const { state } = await readUnlocked(repoPath)
    state.comments = state.comments.filter((stored) => stored.id !== id)
    await writeState(repoPath, state)
    return state.comments
  })
}
