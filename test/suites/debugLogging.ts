import { installDesktopRuntime } from '../desktopRuntime.ts'
import { clickTreeRow, command, poll, settled, sleep, type Suite } from '../harness.ts'

interface Event {
  page: string
  event: string
  details: Record<string, string | number | boolean>
}

export default {
  name: 'debug-logging',
  async run({ page, load, repoPath }, check) {
    await load()
    const events = () =>
      page.evaluate(async () =>
        (await window.go!.main.desktopApp.DebugLog())
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ) as Promise<Event[]>
    await command(page, 'refresh')
    await settled(page)
    check('the review records nothing while debug logging is off', (await events()).length === 0)

    const settings = await page.browserContext().newPage()
    await installDesktopRuntime(settings)
    await settings.goto(new URL('/settings', page.url()).href, { waitUntil: 'networkidle0' })
    await settings.click('.settings-panes button:nth-child(3)')
    const toggle = () =>
      settings.evaluate(() => {
        const input = [...document.querySelectorAll('label.settings-field')]
          .find((label) => label.textContent?.includes('Debug logging'))
          ?.querySelector('input')
        if (!input) throw new Error('Missing Debug logging setting')
        input.click()
        return input.checked
      })
    check('debug logging can be enabled from Window settings', await toggle())
    await page.bringToFront()
    await poll(events, (entries) => entries.some((entry) => entry.event === 'window.ready'))

    await clickTreeRow(page, 'src/core/engine.ts')
    await sleep(400)
    await page.evaluate(() => {
      for (const host of document.querySelectorAll('.diff diffs-container')) {
        if (
          !host.shadowRoot
            ?.querySelector('[data-title]')
            ?.textContent?.includes('src/core/engine.ts')
        )
          continue
        const cell = host.shadowRoot.querySelector('[data-column-number]')
        if (!cell) continue
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
        return
      }
      throw new Error('No engine line to comment on')
    })
    await command(page, 'comment')
    await page.waitForSelector('.comment-composer textarea')
    await page.type('.comment-composer textarea', 'DEBUG-DRAFT-MUST-NOT-BE-EXPORTED')
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/api/comments'),
    )
    await page.click('.comment-composer footer button:last-child')
    await saved
    const recorded = await poll(events, (entries) =>
      entries.some((entry) => entry.event === 'comment.response'),
    )
    check(
      'the trace follows opening, rendering and saving a comment',
      [
        'comment.open',
        'comment.rendered',
        'comment.submit',
        'comment.close',
        'comment.request',
        'comment.response',
      ].every((name) => recorded.some((entry) => entry.event === name)),
    )
    const navigationButtons = await page.evaluate(() => {
      const accepted = [3, 4].map((button) =>
        document.body.dispatchEvent(
          new MouseEvent('auxclick', { button, bubbles: true, composed: true, cancelable: true }),
        ),
      )
      document.body.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 120, bubbles: true, composed: true }),
      )
      const data = new DataTransfer()
      data.setData('text/plain', 'PRIVATE-CLIPBOARD-CONTENT')
      document.body.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, composed: true }),
      )
      for (let x = 0; x < 250; x++)
        document.body.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: x,
            pointerType: 'mouse',
            bubbles: true,
            composed: true,
          }),
        )
      return accepted.every(Boolean)
    })
    const actions = await poll(events, (entries) =>
      entries.some(
        (entry) =>
          entry.event === 'action.pointermove' &&
          entry.details.x === 249 &&
          entry.details.trusted === false,
      ),
    )
    check(
      'mouse back and forward are logged without suppressing their behavior',
      navigationButtons &&
        ['back', 'forward'].every((button) =>
          actions.some(
            (entry) => entry.event === 'action.auxclick' && entry.details.mouseButton === button,
          ),
        ),
    )
    check(
      'clicks, wheel and keyboard actions are retained',
      [
        'action.click',
        'action.pointerdown',
        'action.wheel',
        'action.keydown',
        'action.keyup',
        'action.input',
      ].every((name) => actions.some((entry) => entry.event === name)),
    )
    check(
      'editable keyboard input masks both characters and physical key codes',
      actions.some(
        (entry) =>
          entry.event === 'action.keydown' &&
          entry.details.tag === 'TEXTAREA' &&
          entry.details.key === '[text]' &&
          entry.details.code === '[text]',
      ),
    )
    check(
      'earlier events remain after more than 200 UI actions',
      actions.length > 200 && actions.some((entry) => entry.event === 'window.ready'),
    )

    await settings.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            document.documentElement.dataset.debugCopy = value
          },
        },
      }),
    )
    const copy = () =>
      settings.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === 'Copy debug logs')
          ?.click(),
      )
    await copy()
    await settings.waitForFunction(() => Boolean(document.documentElement.dataset.debugCopy))
    const copied = await settings.evaluate(() => document.documentElement.dataset.debugCopy ?? '')
    const report = JSON.parse(copied)
    check(
      'copied logs include the app build and WebView version',
      typeof report.environment.build?.version === 'string' &&
        report.environment.userAgent.includes('Chrome'),
    )
    check(
      'logs omit draft text, source code and absolute checkout paths',
      !copied.includes('DEBUG-DRAFT-MUST-NOT-BE-EXPORTED') &&
        !copied.includes('PRIVATE-CLIPBOARD-CONTENT') &&
        !copied.includes('engine_69 = 69') &&
        !copied.includes(repoPath),
    )

    const navigated = page.waitForNavigation({ waitUntil: 'networkidle0' })
    await command(page, 'reload')
    await navigated
    await page.waitForSelector('.viewed-toggle input')
    const restored = await poll(
      events,
      (entries) => entries.filter((entry) => entry.event === 'window.ready').length >= 2,
    )
    check(
      'the preference and events survive a full reload',
      restored.some((entry) => entry.event === 'comment.submit') &&
        new Set(
          restored.filter((entry) => entry.event === 'window.ready').map((entry) => entry.page),
        ).size >= 2,
    )

    const activePage = restored.filter((entry) => entry.event === 'window.ready').at(-1)?.page
    await toggle()
    await poll(events, (entries) =>
      entries.some((entry) => entry.event === 'logging.disabled' && entry.page === activePage),
    )
    const before = (await events()).length
    await command(page, 'refresh')
    await settled(page)
    check(
      'turning logging off stops recording in the review window',
      (await events()).length === before,
    )
    await settings.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Clear')
        ?.click(),
    )
    check(
      'Settings can clear the recorded trace',
      (await poll(events, (entries) => entries.length === 0)).length === 0,
    )
    await settings.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('clipboard unavailable')
          },
        },
      }),
    )
    await copy()
    await settings.waitForSelector('[role="alert"]')
    check(
      'a failed clipboard copy is explained',
      await settings.$eval(
        '[role="alert"]',
        (element) => element.textContent?.includes('Could not copy debug logs') === true,
      ),
    )
    await settings.close()
  },
} satisfies Suite
