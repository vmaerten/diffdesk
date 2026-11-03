import type { HTTPRequest } from 'puppeteer-core'

import { command, until, type Suite } from '../harness.ts'

export default {
  name: 'loading',
  async run({ page, load, url }, check) {
    await load()
    // Diff requests wait here until the check releases them.
    const held: HTTPRequest[] = []
    let holding = true
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      if (holding && new URL(request.url()).pathname.endsWith('/api/diff')) held.push(request)
      else void request.continue()
    })
    const release = async () => {
      holding = false
      await Promise.all(held.splice(0).map((request) => request.continue()))
    }

    await command(page, 'refresh')
    check(
      'a reload shows the progress bar',
      await until(
        page,
        `document.querySelector('.app[aria-busy="true"] .review-progress') !== null`,
      ),
    )
    check(
      'the diff on screen is dimmed until the new one arrives',
      await until(page, `getComputedStyle(document.querySelector('.diff')).opacity === '0.45'`),
    )
    await release()
    check(
      'the bar and the dimming leave once the diff arrives',
      await until(
        page,
        `!document.querySelector('.review-progress') &&
          getComputedStyle(document.querySelector('.diff')).opacity === '1'`,
      ),
    )

    holding = true
    await page.goto(url())
    check(
      'the first load says the diff is loading',
      await until(page, `document.querySelector('.review-loading')?.checkVisibility() === true`),
    )
    await release()
    check(
      'the first load message gives way to the diff',
      await until(
        page,
        `!document.querySelector('.review-loading') && !!document.querySelector('.diff')`,
      ),
    )
  },
} satisfies Suite
