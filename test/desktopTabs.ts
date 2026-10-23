// After task build and task desktop:assets: node test/desktopTabs.ts. Real React/API, simulated Wails bindings.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from 'puppeteer-core'
import { installDesktopRuntime, serveDesktopUI } from './desktopRuntime.ts'
import { serveGo } from './goBinary.ts'
import { findChrome } from './harness.ts'

const repo = mkdtempSync(join(tmpdir(), 'ghl-desktop-tabs-'))
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'pipe',
  })
git('init', '-b', 'main')
git('config', 'user.name', 'Desktop fixture')
git('config', 'user.email', 'fixture@example.invalid')
const contents = Array.from({ length: 200 }, (_, index) => `line ${index + 1}\n`).join('')
writeFileSync(join(repo, 'context.txt'), contents)
git('add', '.')
git('commit', '-m', 'base')
writeFileSync(
  join(repo, 'context.txt'),
  contents.replace('line 10\n', 'changed 10\n').replace('line 190\n', 'changed 190\n'),
)

const backend = await serveGo(repo)
let frontend: Awaited<ReturnType<typeof serveDesktopUI>> | undefined
let browser: Awaited<ReturnType<typeof launch>> | undefined
try {
  frontend = await serveDesktopUI(backend.origin)
  const origin = frontend.origin
  browser = await launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await installDesktopRuntime(page, [
    { id: '1', name: 'first', path: '~/first', route: `/r/${backend.repoId}/?base=HEAD` },
    { id: '2', name: 'second', path: '~/second', route: `/r/${backend.repoId}/?base=main` },
  ])
  await page.goto(origin, { waitUntil: 'networkidle0' })
  const ready = async (id: string) => {
    await page.waitForSelector(`.desktop-review[data-active-tab="${id}"] .viewed-toggle input`)
    await page.waitForFunction(
      () => !!document.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line]'),
    )
  }
  const activate = async (id: string) => {
    await page.click(`#review-tab-${id}`)
    await ready(id)
  }
  await ready('1')
  let failures = 0
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
      console.log(`ok ${name}`)
    } catch (error) {
      failures++
      console.error(`FAIL ${name}: ${String(error)}`)
    }
  }
  await test('failed comment survives switching while its save is pending, then retries', async () => {
    let intercept = true
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (intercept && request.method() === 'POST' && request.url().includes('/api/comments'))
        return
      void request.continue()
    })
    await page.evaluate(() => {
      const cell = document
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[data-column-number="10"]')
      if (!cell) throw new Error('Missing comment line')
      const bounds = cell.getBoundingClientRect()
      const options = {
        bubbles: true,
        composed: true,
        pointerType: 'mouse',
        pointerId: 1,
        button: 0,
        clientX: bounds.x + 4,
        clientY: bounds.y + bounds.height / 2,
      }
      cell.dispatchEvent(new PointerEvent('pointerdown', { ...options, buttons: 1 }))
      cell.dispatchEvent(new PointerEvent('pointerup', options))
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    })
    await page.waitForSelector('.comment-composer textarea')
    await page.type('.comment-composer textarea', 'Keep this failed comment')
    const savingRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/api/comments'),
    )
    await page.click('.comment-composer footer button:last-child')
    const pending = await savingRequest
    await page.waitForSelector('.comment-state')
    await activate('2')
    assert.equal(
      await page.evaluate(() => document.body.textContent?.includes('Keep this failed comment')),
      false,
    )
    await pending.respond({
      status: 500,
      contentType: 'application/json',
      body: '{"error":"fixture failure"}',
    })
    await activate('1')
    assert.equal(
      await page.evaluate(() => document.body.textContent?.includes('Keep this failed comment')),
      true,
    )
    await page.waitForSelector('.comment-state.failed')
    intercept = false
    await page.evaluate(() => {
      const retry = [...document.querySelectorAll<HTMLButtonElement>('.comment button')].find(
        (button) => button.textContent === 'Retry',
      )
      if (!retry) throw new Error('Missing retry action')
      retry.click()
    })
    await page.waitForFunction(() => !document.querySelector('.comment-state'))
    await activate('2')
    await activate('1')
    assert.equal(
      await page.evaluate(() => document.body.textContent?.includes('Keep this failed comment')),
      true,
    )
  })
  await test('Expand all survives tab switches', async () => {
    await activate('1')
    await page.evaluate(() => {
      const control = document
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[data-expand-index="1"] [data-expand-all-button]')
      if (!control) throw new Error('Missing Expand all')
      control.click()
    })
    await page.waitForFunction(
      () =>
        !!document
          .querySelector('diffs-container')
          ?.shadowRoot?.querySelector('[data-column-number="20"]'),
    )
    await activate('2')
    await activate('1')
    await page.waitForFunction(
      () =>
        !!document
          .querySelector('diffs-container')
          ?.shadowRoot?.querySelector('[data-column-number="20"]'),
      { timeout: 3000 },
    )
    assert.equal(await page.$$('.app').then((items) => items.length), 1)
  })
  await test('clicking unmodified lines restores both directions without expanding the full gap', async () => {
    await page.goto(origin, { waitUntil: 'networkidle0' })
    await ready('1')
    await page.evaluate(() => {
      const control = document
        .querySelector('diffs-container')
        ?.shadowRoot?.querySelector<HTMLElement>('[data-expand-index="1"] [data-unmodified-lines]')
      if (!control) throw new Error('Missing unmodified lines control')
      control.click()
    })
    await page.waitForFunction(
      () =>
        !!document
          .querySelector('diffs-container')
          ?.shadowRoot?.querySelector('[data-column-number="20"]'),
    )
    await activate('2')
    await activate('1')
    await page.waitForFunction(
      () =>
        !!document
          .querySelector('diffs-container')
          ?.shadowRoot?.querySelector('[data-column-number="20"]'),
      { timeout: 3000 },
    )
    assert.equal(
      await page.evaluate(
        () =>
          !!document
            .querySelector('diffs-container')
            ?.shadowRoot?.querySelector('[data-column-number="60"]'),
      ),
      false,
    )
  })
  assert.deepEqual(errors, [])
  assert.equal(failures, 0, 'Desktop tab regressions')
} finally {
  await browser?.close()
  await frontend?.close()
  await backend.close()
  rmSync(repo, { recursive: true, force: true })
}
