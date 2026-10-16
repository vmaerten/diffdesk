import { goBinary } from './goBinary.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { launch } from 'puppeteer-core'

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
    const server: ImageTestServer = {
      origin: `http://127.0.0.1:${info.port}`,
      repoId: info.repoId,
      close: async () => {
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
console.log(`  ok ${checks} Go image API and browser checks`)
