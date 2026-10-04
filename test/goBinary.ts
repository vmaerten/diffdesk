import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

/** Acceptance suites can select the executable extracted from a release archive. */
export function goBinary(): string {
  return realpathSync(
    process.env.GHL_TEST_BINARY ?? fileURLToPath(new URL('../go/dist/ghl', import.meta.url)),
  )
}

export async function serveGo(repoPath: string) {
  const child = spawn(
    goBinary(),
    ['--repo', repoPath, '--no-daemon', '--port', '0', '--no-open', '--json'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GHL_PORT: '',
        ...(process.env.GHL_TEST_GIT_PATH ? { PATH: process.env.GHL_TEST_GIT_PATH } : {}),
      },
    },
  )
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
    return {
      origin: `http://127.0.0.1:${info.port}`,
      repoId: info.repoId,
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
