import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { git, gitBlob } from './git.ts'
import { linesAt, sectionHashes } from './state.ts'
import type { Comment, DiffFiles, DiffSide, PatchResult, ServedComment } from './types.ts'

const MAX_BYTES = 20 * 1024 * 1024
const empty = (name: string) => ({ name, contents: '', cacheKey: 'empty', sha1: '' })
const changed = () => new Error('Comparison changed; refresh the diff before expanding context')

/** Read only regular repository files, with a bounded read even if they grow. */
async function readText(repoPath: string, revision: string | null, path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new Error('Unsupported file path')
  let bytes: Buffer
  if (revision === null) {
    const file = join(await realpath(repoPath), path)
    if ((await realpath(file)) !== file || !(await lstat(file)).isFile()) {
      throw new Error('Context is available only for regular files, not symlinks or special files')
    }
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Not a regular file')
      if (stat.size > MAX_BYTES) throw new Error('File exceeds the 20 MB context limit')
      const buffer = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > stat.size) throw changed()
      bytes = buffer.subarray(0, size)
    } finally {
      await handle.close()
    }
  } else {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Invalid revision')
    const entry = await git(repoPath, [
      '--literal-pathspecs',
      'ls-tree',
      '-z',
      '-l',
      revision,
      '--',
      path,
    ])
    const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t/.exec(entry)
    if (!match) throw new Error('Context is available only for regular files')
    if (Number(match[3]) > MAX_BYTES) throw new Error('File exceeds the 20 MB context limit')
    bytes = await gitBlob(repoPath, match[2]!, MAX_BYTES)
  }
  if (bytes.includes(0)) throw new Error('Binary files cannot be expanded')
  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('Context requires UTF-8 text')
  }
  const objectId = (algorithm: string) =>
    createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  return { name: path, contents, cacheKey: objectId('sha256'), sha1: objectId('sha1') }
}

/** Only patch coordinates and blob IDs; the server runtime has no UI dependencies. */
function patchMetadata(patch: string) {
  return new Map(
    patch.split(/(?=^diff --git )/m).flatMap((section) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section)
      if (!header) return []
      const ids = /^index ([a-f0-9]+)\.\.([a-f0-9]+)/m.exec(section)
      const hunks = [...section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(
        (match) => ({
          deletionStart: Number(match[1]),
          deletionCount: Number(match[2] ?? 1),
          additionStart: Number(match[3]),
          additionCount: Number(match[4] ?? 1),
        }),
      )
      return [
        [
          header[2]!,
          { prevName: header[1]!, prevObjectId: ids?.[1], newObjectId: ids?.[2], hunks },
        ] as const,
      ]
    }),
  )
}

/** One reader per comparison/request: comments on the same file share its IO. */
export function comparisonReader(repoPath: string, result: PatchResult) {
  const loaded = new Map<string, Promise<DiffFiles>>()
  const hashes = sectionHashes(result.patch)
  let metadata: ReturnType<typeof patchMetadata> | undefined

  const sources = new Map<string, Promise<Awaited<ReturnType<typeof readText>>>>()
  const describe = (path: string) => {
    const stat = result.files.find((file) => file.path === path)
    if (!stat || stat.binary || !hashes[path])
      throw new Error('File is not a text file in this comparison')
    metadata ??= patchMetadata(result.patch)
    const diff = metadata.get(path)
    if (!diff) throw new Error('File is not in this patch')
    return { stat, diff }
  }

  const source = (path: string, side: DiffSide) => {
    const key = `${path}\0${side}`
    const previous = sources.get(key)
    if (previous) return previous
    const pending = (async () => {
      const { stat, diff } = describe(path)
      const old = side === 'deletions'
      const absent = old
        ? stat.status === 'added' || stat.status === 'untracked'
        : stat.status === 'deleted'
      const file = absent
        ? empty(path)
        : await readText(
            repoPath,
            old ? result.comparison.before : result.comparison.after,
            old ? diff.prevName : path,
          )
      const oid = old ? diff.prevObjectId : diff.newObjectId
      if (oid && !/^0+$/.test(oid) && !file.sha1.startsWith(oid) && !file.cacheKey.startsWith(oid))
        throw changed()
      // Reject transformed patches (e.g. textconv) whose displayed lines do
      // not describe the bytes we loaded.
      const contents = file.contents.split('\n')
      for (const hunk of diff.hunks) {
        const start = old ? hunk.deletionStart : hunk.additionStart
        const count = old ? hunk.deletionCount : hunk.additionCount
        if (!count) continue
        const expected = linesAt(result.patch, { path, side, start, end: start + count - 1 })
        if (!expected || expected.some((line, index) => contents[start - 1 + index] !== line))
          throw changed()
      }
      return file
    })()
    sources.set(key, pending)
    return pending
  }

  const files = (path: string, expectedHash?: string): Promise<DiffFiles> => {
    if (expectedHash !== undefined && hashes[path] !== expectedHash)
      return Promise.reject(changed())
    const previous = loaded.get(path)
    if (previous) return previous
    const pending = (async (): Promise<DiffFiles> => {
      const { stat, diff } = describe(path)
      const [oldFile, newFile] = await Promise.all([
        source(path, 'deletions'),
        source(path, 'additions'),
      ])
      if (diff.hunks.length === 0 && oldFile.contents !== newFile.contents) throw changed()
      const pureRename = stat.status === 'renamed' && diff.hunks.length === 0
      return { oldFile: pureRename ? null : oldFile, newFile }
    })()
    loaded.set(path, pending)
    return pending
  }

  const lines = async (location: { path: string; side: DiffSide; start: number; end: number }) => {
    const { path, side, start, end } = location
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
    if (!result.files.some((file) => file.path === path && !file.binary)) return null
    const fromPatch = linesAt(result.patch, location)
    if (fromPatch) return fromPatch
    const file = await source(path, side)
    const all = file.contents.split('\n')
    if (all.at(-1) === '') all.pop()
    return end <= all.length ? all.slice(start - 1, end) : null
  }

  const comments = async (stored: Comment[]): Promise<ServedComment[]> =>
    Promise.all(
      stored.map(async (comment) => {
        // An unavailable file makes the anchor stale; it must not hide the review.
        const code = (await lines(comment).catch(() => null)) ?? []
        const stale =
          comment.anchor.length > 0 &&
          (code.length !== comment.anchor.length ||
            code.some((line, index) => line !== comment.anchor[index]))
        return { ...comment, code, stale }
      }),
    )
  return { files, lines, comments }
}
