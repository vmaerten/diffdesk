import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Newest mtime across the code this process runs, so an edit to the server is
 * enough to make the instance already listening the *previous* version.
 *
 * `web-dist/` is deliberately out: the front end is read from disk on every
 * request, so rebuilding it must not cost a restart — that is the whole point of
 * iterating with `pnpm dev` against a running instance.
 */
function sourceStamp(): string {
  const files = [
    join(ROOT, 'bin', 'ghl.ts'),
    ...readdirSync(join(ROOT, 'src'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(ROOT, 'src', name)),
  ]
  let newest = 0
  for (const file of files) newest = Math.max(newest, statSync(file).mtimeMs)
  // The count too: deleting a file need not move any remaining mtime.
  return `dev-${files.length}-${Math.round(newest)}`
}

/**
 * What this runtime is, so an instance left over from another build is replaced
 * instead of reused.
 *
 * `scripts/install.ts` writes the short SHA at the root of the copy it makes.
 * Running from the checkout leaves no such file — and `package.json` version has
 * stood at 0.1.0 since the first commit, so it would tell us nothing.
 */
export function runtimeRevision(): string {
  try {
    return readFileSync(join(ROOT, 'INSTALLED'), 'utf8').trim().split(' ')[0] || sourceStamp()
  } catch {
    return sourceStamp() // no INSTALLED file: this is the checkout, not an install
  }
}
