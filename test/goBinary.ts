import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { fakeGh } from './fakeGh.ts'

/** Git without the machine's global and system config, so results do not depend on it. */
export const isolatedGit = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

/** The review server without the desktop window, built by `task build`. */
export function goBinary(): string {
  return realpathSync(fileURLToPath(new URL('../go/dist/diffdesk-dev', import.meta.url)))
}

/** Serve `repoPath` on a free port; `args` adds options such as `--base`, `env` variables. */
export async function serveGo(
  repoPath: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
) {
  const child = spawn(goBinary(), ['--repo', repoPath, ...args, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...isolatedGit,
      DIFFDESK_GH: fakeGh,
      ...(process.env.DIFFDESK_TEST_GIT_PATH ? { PATH: process.env.DIFFDESK_TEST_GIT_PATH } : {}),
      ...env,
    },
  })
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += String(chunk)
  })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const timer = setTimeout(() => child.kill('SIGTERM'), 20_000)
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      exited.then(() => {
        throw new Error(`Go startup failed: ${errors}`)
      }),
    ])
    const info: { port: number; repoId: string } = JSON.parse(line)
    const origin = `http://127.0.0.1:${info.port}`
    return {
      origin,
      repoId: info.repoId,
      /** The repository's routes, as in `${base}/api/diff`. */
      base: `${origin}/r/${info.repoId}`,
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGINT')
        const deadline = setTimeout(() => child.kill('SIGKILL'), 6000)
        try {
          assert.equal((await exited)[0], 0, errors)
        } finally {
          clearTimeout(deadline)
        }
      },
    }
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  } finally {
    clearTimeout(timer)
    lines.close()
  }
}

/**
 * A folder holding the only language server the review server may find: the
 * fake one, as `tsrs`. Go and Rust then have none, whatever this machine has.
 * Its `mise` installs a Python server and fails for anything else.
 */
export function fakeLanguageServers(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'diffdesk-servers-'))
  const server = fileURLToPath(new URL('./fakeLanguageServer.ts', import.meta.url))
  writeFileSync(join(path, 'tsrs'), `#!/bin/sh\nexec '${process.execPath}' '${server}' "$@"\n`, {
    mode: 0o755,
  })
  writeFileSync(
    join(path, 'mise'),
    `#!/bin/sh
if [ "$3" = pipx:basedpyright ]; then
  printf '#!/bin/sh\\n' > "\${0%/*}/basedpyright-langserver"
  /bin/chmod +x "\${0%/*}/basedpyright-langserver"
  exit 0
fi
echo "mise ERROR no metadata for $3" >&2
exit 1
`,
    { mode: 0o755 },
  )
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}
