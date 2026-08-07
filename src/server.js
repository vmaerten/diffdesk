import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { currentBranch, headSha, listRefDetails, repoState } from './git.js'
import { buildPatch, detectTrunk, rememberBase, resolveBase } from './revision.js'
import { clearViewed, pruneStale, readState, sectionHashes, setViewed } from './state.js'

const UI_DIR = fileURLToPath(new URL('../web-dist', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
}

/**
 * Stable, readable id for a repository.
 *
 * The path hash keeps two checkouts of the same repo (worktrees — 9 of the repos
 * here have several) from colliding.
 */
export function repoIdFor(repoPath) {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 7)
  return `${basename(repoPath)}-${hash}`
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Serve a built asset. Returns false when the UI has not been built. */
function serveStatic(res, relativePath) {
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

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

/**
 * HTTP server over one or more repositories.
 *
 * Routes are namespaced by repo from day one (`/r/:repoId/...`) even though the
 * CLI currently registers a single one — decision 1 in PLAN.md.
 */
export function createGhlServer({ repos }) {
  const registry = new Map(repos.map((r) => [repoIdFor(r.repoPath), r]))

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)

    try {
      if (url.pathname === '/api/repos') {
        return json(res, 200, {
          repos: [...registry.entries()].map(([id, r]) => ({ id, path: r.repoPath })),
        })
      }

      // Built assets are requested from the root, whatever repo is being viewed.
      if (segments[0] !== 'r') {
        if (req.method === 'GET' && serveStatic(res, url.pathname)) return
        return json(res, 404, { error: 'not found' })
      }

      if (segments.length < 2) return json(res, 404, { error: 'not found' })

      const repoId = segments[1]
      const entry = registry.get(repoId)
      if (!entry) return json(res, 404, { error: `unknown repo: ${repoId}` })

      const route = segments.slice(2).join('/')
      const { repoPath } = entry

      if (route === 'api/diff' && req.method === 'GET') {
        const override = url.searchParams.get('base') ?? entry.baseOverride
        const base = await resolveBase(repoPath, { override })
        const { patch, untracked, untrackedIncluded, files, totals } = await buildPatch(
          repoPath,
          base.ref,
          { includeUntracked: entry.includeUntracked ?? false }
        )
        const branch = await currentBranch(repoPath)
        const range = `${base.ref}..${branch ?? 'HEAD'}`
        const hashes = sectionHashes(patch)

        // Ticks only survive while the file's diff is unchanged.
        const stored = (await readState(repoPath)).viewed?.[range] ?? {}
        const viewed = pruneStale(stored, hashes)

        return json(res, 200, {
          repo: { id: repoId, path: repoPath },
          base,
          head: { branch, sha: await headSha(repoPath) },
          range,
          state: await repoState(repoPath),
          untracked,
          untrackedIncluded,
          files: files.map((f) => ({ ...f, hash: hashes[f.path] ?? null })),
          totals,
          viewed,
          patch,
        })
      }

      if (route === 'api/refs' && req.method === 'GET') {
        const [refs, trunk, branch] = await Promise.all([
          listRefDetails(repoPath),
          detectTrunk(repoPath),
          currentBranch(repoPath),
        ])
        return json(res, 200, { refs, trunk, branch })
      }

      if (route === 'api/viewed' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        if (body.clear) return json(res, 200, { viewed: await clearViewed(repoPath, body.range) })
        if (!body.range || !body.path) return json(res, 400, { error: 'missing "range" or "path"' })
        const viewed = await setViewed(repoPath, body)
        return json(res, 200, { viewed })
      }

      if (route === 'api/base' && req.method === 'POST') {
        const { base } = JSON.parse((await readBody(req)) || '{}')
        if (!base) return json(res, 400, { error: 'missing "base"' })
        const branch = await currentBranch(repoPath)
        await rememberBase(repoPath, branch, base)
        return json(res, 200, { ok: true, branch, base })
      }

      // Anything else under /r/<repoId> is a UI route: hand back the app shell.
      if (req.method === 'GET' && !route.startsWith('api/')) {
        if (serveStatic(res, 'index.html')) return
        return json(res, 503, {
          error: 'UI not built — run `npm run build` in the ghl checkout',
        })
      }

      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  })

  return server
}

export function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}
