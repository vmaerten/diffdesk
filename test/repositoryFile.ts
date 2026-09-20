import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repositoryFile, RepositoryFileError } from '../src/repositoryFile.ts'
import { imageComparisons, readImage } from '../src/images.ts'
import type { Check } from './harness.ts'

async function rejection(operation: Promise<unknown>) {
  try {
    await operation
    return null
  } catch (error) {
    return error
  }
}

export async function runRepositoryFile(check: Check): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), 'ghl-repository-file-'))
  const previousTrace = process.env.GIT_TRACE
  const trace = join(repo, 'trace.log')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  try {
    git('init', '-q', '--initial-branch=main')
    git('config', 'user.name', 'Repository file tests')
    git('config', 'user.email', 'repository-file@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'core.hooksPath', '/dev/null')
    const samples = new Map([
      ['empty', Buffer.alloc(0)],
      ['text [1].txt', Buffer.from('\ufeffhéllo\r\n')],
      ['binary.png', Buffer.from([0, 255, 128, 10])],
      ['executable', Buffer.from('#!/bin/sh\n')],
    ])
    for (const [path, bytes] of samples) writeFileSync(join(repo, path), bytes)
    chmodSync(join(repo, 'executable'), 0o755)
    mkdirSync(join(repo, 'directory'))
    writeFileSync(join(repo, 'directory', 'child'), 'child')
    symlinkSync('text [1].txt', join(repo, 'link'))
    symlinkSync('directory', join(repo, 'linked-directory'))
    git('add', '-A')
    git('commit', '-qm', 'files')
    const revision = git('rev-parse', 'HEAD')

    for (const version of [null, revision]) {
      const label = version === null ? 'worktree' : 'Git'
      for (const [path, bytes] of samples) {
        const source = await repositoryFile(repo, version, path, bytes.length)
        check(
          `${label} preserves bytes and size at the exact limit: ${path}`,
          source.size === bytes.length && (await source.read()).equals(bytes),
        )
        check(
          `${label} reports the source identity: ${path}`,
          source.objectId === (version === null ? null : git('rev-parse', `${revision}:${path}`)),
        )
      }
      const tooLarge = await rejection(repositoryFile(repo, version, 'binary.png', 3))
      check(
        `${label} rejects oversized files`,
        tooLarge instanceof RepositoryFileError && tooLarge.reason === 'too-large',
      )
      for (const path of [
        '',
        '/outside',
        '../outside',
        './empty',
        'directory//child',
        'directory/',
        '.git/config',
        '.GiT/config',
        'directory/../empty',
        'a\\b',
        'a\0b',
      ]) {
        const error = await rejection(repositoryFile(repo, version, path, 100))
        check(
          `${label} rejects invalid path ${JSON.stringify(path)}`,
          error instanceof RepositoryFileError && error.reason === 'invalid-path',
        )
      }
      for (const path of ['directory', 'link', 'linked-directory/child']) {
        const error = await rejection(repositoryFile(repo, version, path, 100))
        check(
          `${label} rejects non-regular source ${path}`,
          error instanceof RepositoryFileError &&
            ['symlink', 'non-regular-path', 'non-regular-git'].includes(error.reason),
        )
      }
      check(
        `${label} rejects missing files`,
        (await rejection(repositoryFile(repo, version, 'missing', 100))) instanceof Error,
      )
    }
    for (const invalid of ['', 'HEAD', revision.slice(0, 12), `${revision}^`, 'g'.repeat(40)]) {
      const error = await rejection(repositoryFile(repo, invalid, 'empty', 100))
      check(
        `rejects revision expression ${JSON.stringify(invalid)}`,
        error instanceof RepositoryFileError && error.reason === 'invalid-revision',
      )
    }

    const snapshot = await repositoryFile(repo, null, 'binary.png', 100)
    writeFileSync(join(repo, 'binary.png'), 'replacement')
    check(
      'worktree reads return the captured bytes after the file changes',
      (await snapshot.read()).equals(samples.get('binary.png')!),
    )
    const refreshed = await repositoryFile(repo, null, 'binary.png', 100)
    check(
      'a new source observes the changed worktree',
      (await refreshed.read()).toString() === 'replacement',
    )

    writeFileSync(trace, '')
    process.env.GIT_TRACE = trace
    const blobReads = () =>
      (readFileSync(trace, 'utf8').match(/built-in: git cat-file blob /g) ?? []).length
    const source = await repositoryFile(repo, revision, 'binary.png', 100)
    check('committed metadata does not read blob bytes', source.size === 4 && blobReads() === 0)
    const [first, second] = await Promise.all([source.read(), source.read()])
    check(
      'concurrent reads share one blob load',
      first === second && first.equals(samples.get('binary.png')!) && blobReads() === 1,
    )
    check(
      'later reads reuse the captured blob',
      (await source.read()) === first && blobReads() === 1,
    )

    writeFileSync(trace, '')
    const images = await imageComparisons(repo, 'test', {
      files: [{ path: 'binary.png', status: 'modified', binary: true, additions: 0, deletions: 0 }],
      comparison: { before: revision, after: revision },
    })
    const image = images.get('binary.png')?.image
    check(
      'committed image previews stay lazy and keep the blob identity',
      blobReads() === 0 &&
        image?.after?.bytes === 4 &&
        new URL(image.after.url!, 'http://localhost').searchParams.get('v') === source.objectId,
    )
    check(
      'requesting an image loads its bytes',
      (await readImage(repo, revision, 'binary.png')).equals(samples.get('binary.png')!) &&
        blobReads() === 1,
    )

    // The failure belongs to this source too; a caller must create a new one to retry.
    const failed = await repositoryFile(repo, revision, 'binary.png', 100)
    git('config', 'core.repositoryformatversion', '999')
    writeFileSync(trace, '')
    const failedRead = failed.read()
    const failure = await rejection(failedRead)
    git('config', '--file', join(repo, '.git/config'), 'core.repositoryformatversion', '0')
    check(
      'failed reads stay memoized after the repository recovers',
      failure instanceof Error &&
        failed.read() === failedRead &&
        (await rejection(failed.read())) === failure,
    )
    const recovered = await repositoryFile(repo, revision, 'binary.png', 100)
    check(
      'a new source can retry a failed read',
      (await recovered.read()).equals(samples.get('binary.png')!),
    )
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE
    else process.env.GIT_TRACE = previousTrace
    rmSync(repo, { recursive: true, force: true })
  }
}
