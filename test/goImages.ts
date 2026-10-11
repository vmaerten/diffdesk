import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { launch } from 'puppeteer-core'

import { createGhlServer, listen, repoIdFor } from '../src/server.ts'
import type { DiffPayload } from '../src/types.ts'
import { findChrome, sleep } from './harness.ts'
import { runImages, type ImageTestRuntime, type ImageTestServer } from './images.ts'

const binary = goBinary()
let checks = 0
let active: ImageTestServer | undefined

const runtime: ImageTestRuntime = {
  serve: async (path) => {
    const repo = realpathSync(path)
    const child = spawn(
      binary,
      ['--repo', repo, '--base', 'main', '--no-open', '--no-daemon', '--port', '0', '--json'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk)
    })
    const lines = createInterface({ input: child.stdout })
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000)
    let info: { port: number; repoId: string }
    try {
      const raw = await Promise.race([
        once(lines, 'line').then(([line]) => String(line)),
        once(child, 'exit').then(() => {
          throw new Error(`Go startup failed: ${errors}`)
        }),
      ])
      info = JSON.parse(raw)
    } finally {
      clearTimeout(timer)
      lines.close()
    }
    const reference = createGhlServer({ repos: [{ repoPath: repo }] })
    const nodePort = await listen(reference, 0)
    const server: ImageTestServer = {
      origin: `http://127.0.0.1:${info.port}`,
      repoId: info.repoId,
      compare: async (query, actual) => {
        const response = await fetch(
          `http://127.0.0.1:${nodePort}/r/${repoIdFor(repo)}/api/diff?base=main&${query}`,
          { signal: AbortSignal.timeout(15_000) },
        )
        assert.equal(response.status, 200, await response.clone().text())
        const expected: DiffPayload = await response.json()
        assert.deepEqual(actual.comparison, expected.comparison)
        assert.deepEqual(actual.untracked, expected.untracked)
        assert.equal(actual.untrackedIncluded, expected.untrackedIncluded)
        assert.deepEqual(
          actual.files.map((file) => file.path),
          expected.files.map((file) => file.path),
        )
        const boundedUntracked = new Set(
          actual.files
            .filter(
              (file) =>
                file.status === 'untracked' &&
                (file.image?.before?.error || file.image?.after?.error),
            )
            .map((file) => file.path),
        )
        for (const [index, file] of actual.files.entries()) {
          if (boundedUntracked.has(file.path)) {
            // Go never asks Git to read unsafe/oversized untracked image bytes.
            // These retain a header and preview error, with no invented lines.
            assert.equal(file.hash, expected.files[index]?.hash)
            assert.deepEqual(file.image, expected.files[index]?.image)
            assert.equal(file.status, expected.files[index]?.status)
            assert.equal(file.binary, true)
            assert.equal(file.additions, 0)
            assert.equal(file.deletions, 0)
          } else assert.deepEqual(file, expected.files[index], `${query}: ${file.path}`)
          for (const side of ['before', 'after'] as const) {
            const url = file.image?.[side]?.url
            if (!url) continue
            const [a, b] = await Promise.all([
              fetch(`http://127.0.0.1:${info.port}${url}`),
              fetch(`http://127.0.0.1:${nodePort}${url}`),
            ])
            assert.equal(a.status, 200)
            assert.equal(b.status, 200)
            assert.deepEqual(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer()))
            for (const header of [
              'content-type',
              'content-length',
              'cache-control',
              'x-content-type-options',
              'content-security-policy',
            ])
              assert.equal(a.headers.get(header), b.headers.get(header))
          }
        }
        assert.equal(actual.totals.files, expected.totals.files)
        if (boundedUntracked.size === 0) {
          assert.equal(actual.patch, expected.patch)
          assert.deepEqual(actual.totals, expected.totals)
        }
        checks++
      },
      close: async () => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit')
            child.kill('SIGINT')
            const killTimer = setTimeout(() => child.kill('SIGKILL'), 6000)
            try {
              assert.equal((await exited)[0], 0)
            } finally {
              clearTimeout(killTimer)
            }
          }
        } finally {
          await new Promise<void>((done) => reference.close(() => done()))
        }
      },
    }
    active = server
    return server
  },
  withHarness: async (repo, body) => {
    const server = active
    assert.ok(server, 'image API server must be running before browser checks')
    const browser = await launch({
      executablePath: findChrome(),
      headless: 'shell',
      args: ['--no-sandbox'],
      defaultViewport: { width: 1600, height: 1000 },
    })
    try {
      return await body(async (target) => {
        const page = await browser.newPage()
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(String(error)))
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text())
        })
        const url = (query?: string) =>
          `${server.origin}/r/${server.repoId}${query ?? (target ? '?target=' + encodeURIComponent(target) : '')}`
        return {
          page,
          repoPath: repo,
          errors,
          url,
          load: async (query) => {
            await page.goto(url(query), { waitUntil: 'networkidle0' })
            await page.waitForSelector('file-tree-container')
            await sleep(500)
          },
        }
      }, browser)
    } finally {
      await browser.close()
    }
  },
}

await runImages((name, ok, detail) => {
  assert.ok(ok, `${name}: ${detail ?? ''}`)
  checks++
  console.log(`  ok ${name}`)
}, runtime)
console.log(`  ok ${checks} Go image API parity and browser checks`)
