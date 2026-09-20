import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'

import { git, gitBlob } from './git.ts'
import type { FileStat, ImageComparison, ImageVersion } from './types.ts'

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
}
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const imageType = (path: string): string | undefined =>
  IMAGE_TYPES[extname(path).toLowerCase()]

function validPath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git')
  )
}

/** Only regular image files, never a symlink or a path outside this checkout. */
async function imageSource(repoPath: string, revision: string, path: string) {
  if (!validPath(path) || !imageType(path)) throw new Error('Unsupported image path')
  if (revision === 'worktree') {
    const root = await realpath(repoPath)
    const file = join(root, path)
    if ((await realpath(file)) !== file) throw new Error('Symlink images are not previewed')
    if (!(await lstat(file)).isFile()) throw new Error('Not a regular image file')
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('Not a regular image file')
      if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MB preview limit')
      // Bound the read even if the file grows after stat.
      const buffer = Buffer.alloc(stat.size + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (read.bytesRead === 0) break
        bytesRead += read.bytesRead
      }
      if (bytesRead > stat.size) throw new Error('Image changed while reading; refresh to retry')
      const bytes = buffer.subarray(0, bytesRead)
      return { bytes, size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }
    } finally {
      await handle.close()
    }
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error('Invalid image revision')
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
  if (!match) throw new Error('Image is missing or is not a regular file')
  const size = Number(match[3])
  if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MB preview limit')
  return { oid: match[2]!, size, hash: match[2]! }
}

export async function readImage(repoPath: string, revision: string, path: string): Promise<Buffer> {
  const source = await imageSource(repoPath, revision, path)
  return source.bytes ?? gitBlob(repoPath, source.oid!, MAX_IMAGE_BYTES)
}

/** Metadata is small; the browser only requests bytes for mounted previews. */
export async function imageComparisons(
  repoPath: string,
  repoId: string,
  files: FileStat[],
  before: string,
  after: string | null,
): Promise<Map<string, { image: ImageComparison; hash: string }>> {
  const images = files.filter((file) => imageType(file.path))
  const result = new Map<string, { image: ImageComparison; hash: string }>()
  if (images.length === 0) return result

  const previousPaths = new Map<string, string>()
  if (images.some((file) => file.status === 'renamed')) {
    const fields = (
      await git(repoPath, [
        'diff',
        '--name-status',
        '-z',
        '-M',
        before,
        ...(after ? [after] : []),
        '--',
      ])
    ).split('\0')
    for (let index = 0; index < fields.length;) {
      const status = fields[index++]
      if (!status) continue
      const path = fields[index++]!
      if (status.startsWith('R') || status.startsWith('C'))
        previousPaths.set(fields[index++]!, path)
    }
  }

  const version = async (
    revision: string,
    path: string,
  ): Promise<ImageVersion & { hash: string }> => {
    try {
      const source = await imageSource(repoPath, revision, path)
      const query = new URLSearchParams({ revision, path, v: source.hash })
      return { url: `/r/${repoId}/api/image?${query}`, bytes: source.size, hash: source.hash }
    } catch (error) {
      return {
        url: null,
        error: error instanceof Error ? error.message : 'Image unavailable',
        hash: 'unavailable',
      }
    }
  }

  // Bound concurrent filesystem reads and git processes by visiting one image
  // at a time; the two sides of each image are independent.
  for (const file of images) {
    const [old, next] = await Promise.all([
      file.status === 'added' || file.status === 'untracked'
        ? null
        : version(before, previousPaths.get(file.path) ?? file.path),
      file.status === 'deleted' ? null : version(after ?? 'worktree', file.path),
    ])
    result.set(file.path, {
      image: { before: old, after: next },
      hash: createHash('sha256')
        .update(`${file.path}\0${old?.hash ?? '-'}\0${next?.hash ?? '-'}`)
        .digest('hex')
        .slice(0, 12),
    })
  }
  return result
}
