import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentBranch, headSha, listRefDetails, repoState, resolveRepoRoot } from './git.ts'
import { buildPatch, detectTrunk, rangeKey, rememberBase, resolveBase } from './revision.ts'
import { clearViewed, pruneStale, readState, sectionHashes, setViewed } from './state.ts'
import type { DiffPayload, RefsPayload } from './types.ts'
import { runtimeRevision } from './version.ts'

/** One repository the server is willing to serve, as the CLI registers it. */
export interface RepoEntry {
  repoPath: string
  baseOverride?: string | null
  target?: string | null
  includeUntracked?: boolean
}

/** Why the server is being asked to stop. */
export type StopReason = 'idle' | 'requested'

export interface GhlServerOptions {
  repos: RepoEntry[]
  /**
   * Milliseconds without a request before `onStop('idle')` fires; 0 disables it.
   * The front end sends a heartbeat while its tab is visible, so this measures
   * "nobody is watching", not "nobody has clicked".
   */
  idleMs?: number
  /**
   * What to do when the server should go. Left out, `/api/shutdown` and the idle
   * timer are inert — which is what the test harness wants, since it runs the
   * server inside the process doing the testing.
   */
  onStop?: (reason: StopReason) => void
}

/** How often the idle timer looks at the clock. */
const IDLE_TICK_MS = 60_000

/**
 * Read once, at import: what this process is *running*, not what is on disk now.
 *
 * Recomputing it per request would make every instance report the current
 * sources and therefore always look up to date — which is exactly the staleness
 * this is here to catch.
 */
const REVISION = runtimeRevision()

const UI_DIR = fileURLToPath(new URL('../web-dist', import.meta.url))

/**
 * Hostnames a browser may legitimately use to reach a server bound to the
 * loopback. A fixed port makes the address guessable, so a page that re-resolves
 * its own domain to 127.0.0.1 would otherwise end up same-origin with the source
 * code being served. The port is deliberately not part of the check: an attacker
 * chooses what its domain resolves to, never the Host header the browser sends.
 */
const ALLOWED_HOSTS = new Set(['ghl.localhost', 'localhost', '127.0.0.1', '[::1]'])

/** URL() lowercases the hostname and strips the port, brackets included. */
function isAllowedName(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname)
  } catch {
    return false // an unparseable Host or an opaque `Origin: null`
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/**
 * Stable, readable id for a repository. The path hash keeps two worktrees of the
 * same repo from colliding; 9 of the repositories here have several.
 */
export function repoIdFor(repoPath: string): string {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 7)
  return `${basename(repoPath)}-${hash}`
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Serve a built asset. Returns false when the UI has not been built. */
function serveStatic(res: ServerResponse, relativePath: string): boolean {
  // normalize() collapses any ../ before it can escape the UI directory.
  const target = join(UI_DIR, normalize(relativePath).replace(/^(\.\.[/\\])+/, ''))
  if (!target.startsWith(UI_DIR) || !existsSync(target) || !statSync(target).isFile()) {
    return false
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  createReadStream(target).pipe(res)
  return true
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/**
 * HTTP server over one or more repositories.
 *
 * Routes are namespaced by repo (`/r/:repoId/...`), and the registry takes
 * repositories after the fact: one process serves every checkout the CLI is
 * pointed at, rather than one process per tab.
 */
export function createGhlServer({ repos, idleMs = 0, onStop }: GhlServerOptions): Server {
  const registry = new Map(repos.map((r) => [repoIdFor(r.repoPath), r] as const))
  let lastSeen = Date.now()

  const server = createServer(async (req, res) => {
    const host = req.headers.host
    if (host === undefined || !isAllowedName(`http://${host}`)) {
      return json(res, 403, { error: 'unexpected Host header' })
    }
    // CORS keeps a cross-site page from reading the response, not from firing
    // the request — so the routes that write are checked at the door too.
    const origin = req.headers.origin
    if (req.method !== 'GET' && origin !== undefined && !isAllowedName(origin)) {
      return json(res, 403, { error: 'unexpected Origin header' })
    }
    // Only past the door: a rejected request must not be able to keep the
    // process alive.
    lastSeen = Date.now()

    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)

    try {
      const served = () => [...registry.entries()].map(([id, r]) => ({ id, path: r.repoPath }))

      // The discovery probe, and the heartbeat the front end sends while its tab
      // is visible — which is what makes the idle timeout mean "nobody is here".
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return json(res, 200, {
          ghl: true,
          revision: REVISION,
          pid: process.pid,
          repos: served(),
        })
      }

      if (url.pathname === '/api/repos' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (typeof body.repoPath !== 'string' || body.repoPath === '') {
          return json(res, 400, { error: 'missing "repoPath"' })
        }
        // Resolved here too, not only in the CLI: it rejects a path that is not
        // a repository, and registering a subdirectory registers its root.
        const repoPath = await resolveRepoRoot(body.repoPath)
        const id = repoIdFor(repoPath)
        // set(), so a second `ghl --untracked` updates the entry in place.
        registry.set(id, {
          repoPath,
          baseOverride: body.baseOverride ?? null,
          target: body.target ?? null,
          includeUntracked: body.includeUntracked ?? false,
        })
        return json(res, 200, { id, path: repoPath })
      }

      if (url.pathname === '/api/shutdown' && req.method === 'POST') {
        json(res, 200, { ok: true })
        // After the response: the caller waits for the port to free up, and a
        // socket cut mid-reply would leave it guessing.
        onStop?.('requested')
        return
      }

      if (url.pathname === '/api/repos') {
        return json(res, 200, { repos: served() })
      }

      // Built assets are requested from the root, whatever repo is being viewed.
      if (segments[0] !== 'r') {
        if (req.method === 'GET' && serveStatic(res, url.pathname)) return
        return json(res, 404, { error: 'not found' })
      }

      if (segments.length < 2) return json(res, 404, { error: 'not found' })

      const repoId = segments[1] ?? ''
      const entry = registry.get(repoId)
      if (!entry) return json(res, 404, { error: `unknown repo: ${repoId}` })

      const route = segments.slice(2).join('/')
      const { repoPath } = entry

      if (route === 'api/diff' && req.method === 'GET') {
        const override = url.searchParams.get('base') ?? entry.baseOverride
        const target = url.searchParams.get('target') ?? entry.target ?? null
        const base = await resolveBase(repoPath, { override, target })

        // Everything the response needs beyond the base, and none of it depends
        // on another: awaited one by one, the request waited for the sum of five
        // git round-trips rather than the longest.
        const [patchResult, branch, sha, state, stored] = await Promise.all([
          buildPatch(repoPath, base.ref, {
            target,
            includeUntracked: entry.includeUntracked ?? false,
          }),
          // Without a target, resolveBase has already asked — that is `base.branch`.
          target ? currentBranch(repoPath) : base.branch,
          headSha(repoPath),
          repoState(repoPath),
          readState(repoPath),
        ])

        const { patch, untracked, untrackedIncluded, files, totals } = patchResult
        const reviewing = target ?? branch ?? 'HEAD'
        const range = rangeKey(base.ref, reviewing)
        const hashes = sectionHashes(patch)

        // Ticks only survive while the file's diff is unchanged.
        const viewed = pruneStale(stored.state.viewed[range] ?? {}, hashes)

        const payload: DiffPayload = {
          repo: { id: repoId, path: repoPath },
          base,
          head: { branch, sha },
          target: { ref: reviewing, workingTree: !target },
          range,
          state,
          untracked,
          untrackedIncluded,
          files: files.map((f) => ({ ...f, hash: hashes[f.path] ?? null })),
          totals,
          viewed,
          notice: stored.notice,
          patch,
        }
        return json(res, 200, payload)
      }

      if (route === 'api/refs' && req.method === 'GET') {
        const [refs, trunk, branch] = await Promise.all([
          listRefDetails(repoPath),
          detectTrunk(repoPath),
          currentBranch(repoPath),
        ])
        const payload: RefsPayload = { refs, trunk, branch }
        return json(res, 200, payload)
      }

      if (route === 'api/viewed' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.clear) return json(res, 200, { viewed: await clearViewed(repoPath, body.range) })
        if (!body.range || !body.path) return json(res, 400, { error: 'missing "range" or "path"' })
        const viewed = await setViewed(repoPath, body)
        return json(res, 200, { viewed })
      }

      if (route === 'api/base' && req.method === 'POST') {
        const { base, target } = JSON.parse((await readBody(req)) || '{}')
        if (!base) return json(res, 400, { error: 'missing "base"' })
        // Remember against what is being reviewed, not against the checkout.
        const branch = target ?? (await currentBranch(repoPath))
        await rememberBase(repoPath, branch, base)
        return json(res, 200, { ok: true, branch, base })
      }

      // Anything else under /r/<repoId> is a UI route: hand back the app shell.
      if (req.method === 'GET' && !route.startsWith('api/')) {
        if (serveStatic(res, 'index.html')) return
        return json(res, 503, {
          error: 'UI not built — run `pnpm build` in the ghl checkout',
        })
      }

      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  if (idleMs > 0 && onStop) {
    // Never coarser than the threshold itself, or a short one would never fire.
    const tick = Math.max(250, Math.min(IDLE_TICK_MS, idleMs))
    const timer = setInterval(() => {
      if (Date.now() - lastSeen >= idleMs) onStop('idle')
    }, tick)
    // Never the reason the process stays up: the listening socket is.
    timer.unref()
    server.on('close', () => clearInterval(timer))
  }

  return server
}

export function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('server is not listening on a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

/**
 * Listen on `port`, or on the next free one after it.
 *
 * The point of a fixed port is a URL you can bookmark, so the first choice
 * matters; but a second `ghl` in another repository must still come up rather
 * than fail. Sliding keeps it near enough to recognise, and the ephemeral port
 * at the end means it always comes up.
 */
export async function listenNear(server: Server, port: number, span = 10): Promise<number> {
  if (port === 0) return listen(server, 0)

  for (let candidate = port; candidate < port + span; candidate++) {
    try {
      return await listen(server, candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    }
  }
  return listen(server, 0)
}
