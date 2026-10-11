import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createSocket } from 'node:net'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const repo = resolve(process.env.GHL_DEV_CWD ?? root, process.env.GHL_DEV_REPO ?? root)
const port = Number(process.env.GHL_DEV_PORT ?? '5180')
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid development port')

let vite: ViteDevServer | undefined
let air: ChildProcess | undefined
let stopping: Promise<void> | undefined
const abort = new AbortController()

function stop() {
  return (stopping ??= (async () => {
    abort.abort()
    if (air?.pid && air.exitCode === null && air.signalCode === null) {
      const closed = once(air, 'close').catch(() => {})
      air.kill('SIGINT')
      const pid = air.pid
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already stopped */
        }
      }, 6500)
      await closed
      clearTimeout(timer)
    }
    await vite?.close()
  })())
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => abort.abort())

async function freePort() {
  const socket = createSocket()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const address = socket.address()
  if (!address || typeof address === 'string') throw new Error('Could not select backend port')
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  )
  return address.port
}

try {
  const backendPort = await freePort()
  process.env.GHL_DEV_API = `http://127.0.0.1:${backendPort}`
  vite = await createServer({
    configFile: resolve(root, 'vite.config.js'),
    mode: 'go',
    server: { host: '127.0.0.1', port, strictPort: true },
  })
  await vite.listen()
  if (abort.signal.aborted) throw new Error('Development stopped')
  air = spawn(resolve(root, '.task/bin/air'), ['-c', '.air.toml'], {
    cwd: resolve(root, 'go'),
    env: {
      ...process.env,
      GHL_DEV_REPO: repo,
      GHL_DEV_BASE: process.env.GHL_DEV_BASE ?? '',
      GHL_DEV_BACKEND_PORT: String(backendPort),
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = once(air, 'exit').catch(() => {})
  const lines = createInterface({ input: air.stdout! })
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const ready = new Promise<{ url: string }>((done, reject) => {
    readyTimer = setTimeout(
      () => reject(new Error('Go did not become ready within 30 seconds')),
      30_000,
    )
    abort.signal.addEventListener('abort', () => reject(new Error('Development stopped')), {
      once: true,
    })
    air!.once('error', reject)
    air!.once('exit', () => reject(new Error('Go watcher exited before startup')))
    lines.on('line', (line) => {
      console.log(line)
      if (!line.startsWith('{')) return
      try {
        const info: { port: number; repoId: string; url: string } = JSON.parse(line)
        if (info.port === backendPort && info.repoId && info.url) done(info)
      } catch {
        /* watcher logs are not startup announcements */
      }
    })
    if (abort.signal.aborted) reject(new Error('Development stopped'))
  })
  const info = await ready.finally(() => clearTimeout(readyTimer))
  if (abort.signal.aborted) throw new Error('Development stopped')
  const frontend = vite.resolvedUrls?.local[0]
  if (!frontend) throw new Error('Vite did not announce a local URL')
  const url = new URL(new URL(info.url).pathname + new URL(info.url).search, frontend).href
  console.log(`Dev URL: ${url}`)
  if (process.env.GHL_DEV_OPEN !== 'false' && process.env.GHL_DEV_OPEN !== '0') {
    vite.config.server.open = url
    vite.openBrowser()
  }
  await Promise.race([exited, once(abort.signal, 'abort')])
  if (!abort.signal.aborted) throw new Error('Go watcher stopped unexpectedly')
} catch (error) {
  if (!abort.signal.aborted) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
} finally {
  await stop()
}
