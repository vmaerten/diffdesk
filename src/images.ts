import { createHash } from 'node:crypto'
import { extname } from 'node:path'

import { git } from './git.ts'
import { repositoryFile, RepositoryFileError } from './repositoryFile.ts'
import type { ImageComparison, ImageVersion, PatchResult } from './types.ts'

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

const IMAGE_READ_ERRORS: Record<RepositoryFileError['reason'], string> = {
  'invalid-path': 'Unsupported image path',
  'invalid-revision': 'Invalid image revision',
  symlink: 'Symlink images are not previewed',
  'non-regular-path': 'Not a regular image file',
  'non-regular-handle': 'Not a regular image file',
  'non-regular-git': 'Image is missing or is not a regular file',
  'too-large': 'Image exceeds the 20 MB preview limit',
  changed: 'Image changed while reading; refresh to retry',
}

async function imageSource(repoPath: string, revision: string, path: string) {
  if (!imageType(path)) throw new Error('Unsupported image path')
  try {
    return await repositoryFile(
      repoPath,
      revision === 'worktree' ? null : revision,
      path,
      MAX_IMAGE_BYTES,
    )
  } catch (error) {
    if (error instanceof RepositoryFileError)
      throw new Error(IMAGE_READ_ERRORS[error.reason], { cause: error })
    throw error
  }
}

export async function readImage(repoPath: string, revision: string, path: string): Promise<Buffer> {
  const source = await imageSource(repoPath, revision, path)
  return source.read()
}

/** Metadata is small; the browser only requests bytes for mounted previews. */
export async function imageComparisons(
  repoPath: string,
  repoId: string,
  { files, comparison: { before, after } }: Pick<PatchResult, 'files' | 'comparison'>,
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
      const hash =
        source.objectId ??
        createHash('sha256')
          .update(await source.read())
          .digest('hex')
      const query = new URLSearchParams({ revision, path, v: hash })
      return { url: `/r/${repoId}/api/image?${query}`, bytes: source.size, hash }
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
