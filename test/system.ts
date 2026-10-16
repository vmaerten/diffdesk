import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'

/** Locate acceptance tools without depending on an OS-specific `which` path. */
export function findExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = resolve(directory || '.', name)
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return realpathSync(path)
    } catch {
      // Keep searching the caller's PATH.
    }
  }
  throw new Error(`Test prerequisite not found on PATH: ${name}`)
}
