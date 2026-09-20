import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { git, gitBlob } from './git.ts'

type ReadFailure =
  | 'invalid-path'
  | 'invalid-revision'
  | 'symlink'
  | 'non-regular-path'
  | 'non-regular-handle'
  | 'non-regular-git'
  | 'too-large'
  | 'changed'

/** Callers translate reading failures into their own text or image messages. */
export class RepositoryFileError extends Error {
  readonly reason: ReadFailure

  constructor(reason: ReadFailure) {
    super(reason)
    this.name = 'RepositoryFileError'
    this.reason = reason
  }
}

/**
 * Capture worktree bytes now; defer immutable Git blob bytes until read().
 * Each result owns its reads, including failures; nothing is cached across requests.
 */
export async function repositoryFile(
  repoPath: string,
  revision: string | null,
  path: string,
  maxBytes: number,
): Promise<{ size: number; objectId: string | null; read: () => Promise<Buffer> }> {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new RepositoryFileError('invalid-path')

  if (revision === null) {
    const file = join(await realpath(repoPath), path)
    if ((await realpath(file)) !== file) throw new RepositoryFileError('symlink')
    if (!(await lstat(file)).isFile()) throw new RepositoryFileError('non-regular-path')
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new RepositoryFileError('non-regular-handle')
      if (stat.size > maxBytes) throw new RepositoryFileError('too-large')
      // One extra byte detects growth without allowing an unbounded read.
      const buffer = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, size)
        if (!read.bytesRead) break
        size += read.bytesRead
      }
      if (size > stat.size) throw new RepositoryFileError('changed')
      const bytes = buffer.subarray(0, size)
      return { size, objectId: null, read: () => Promise.resolve(bytes) }
    } finally {
      await handle.close()
    }
  }

  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new RepositoryFileError('invalid-revision')
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
  if (!match) throw new RepositoryFileError('non-regular-git')
  const size = Number(match[3])
  if (size > maxBytes) throw new RepositoryFileError('too-large')
  const objectId = match[2]!
  let pending: Promise<Buffer> | undefined
  return { size, objectId, read: () => (pending ??= gitBlob(repoPath, objectId, maxBytes)) }
}
