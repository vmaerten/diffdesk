import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from 'puppeteer-core'

import { installDesktopRuntime } from '../desktopRuntime.ts'
import { poll, type Suite } from '../harness.ts'

interface ServerRow {
  id: string
  name: string
  detail: string
  state: string | null
  choice: string
}

/**
 * Code intelligence, a beta: its settings, and what the status bar says.
 *
 * The harness's review server finds one language server, the fake one, as
 * `tsrs`; Go and Rust have none. Kept in one suite because the setting lives
 * on the server all suites share.
 */
export default {
  name: 'code-intelligence',
  async run({ page, load, repoPath }, check) {
    // The fixture sits on main: the bare URL reviews this uncommitted change.
    writeFileSync(join(repoPath, 'src/index.ts'), 'export const answer = 42\n')
    await load('')

    /**
     * Settings is a window of its own: a second page of the browser context,
     * whose saves reach the review as Go's event would. Its tabs name the review,
     * as Go answers the window, so it can show that checkout's servers.
     */
    const openSettings = async () => {
      const window = await page.browserContext().newPage()
      const shown = new URL(page.url())
      await installDesktopRuntime(window, [
        { id: '1', name: 'fixture', path: '', route: shown.pathname + shown.search },
      ])
      await window.goto(new URL('/settings', page.url()).href, { waitUntil: 'networkidle0' })
      await window.click('.settings-panes button:last-child')
      await window.waitForSelector('.language-server')
      await page.bringToFront()
      return window
    }
    const rows = (window: Page) =>
      window.evaluate(() =>
        [...document.querySelectorAll('.language-server')].map((row) => ({
          id: row.getAttribute('data-language') ?? '',
          name: row.querySelector('.settings-label > span')?.textContent ?? '',
          detail: row.querySelector('.settings-label small')?.textContent ?? '',
          state: row.querySelector('.server-state')?.getAttribute('data-state') ?? null,
          choice: row.querySelector('select')?.value ?? '',
        })),
      ) as Promise<ServerRow[]>
    const footer = () =>
      page.evaluate(() => ({
        text: document.querySelector('.review-footer .code-intelligence-status')?.textContent ?? '',
        servers: [...document.querySelectorAll('.review-footer .language-state')].map(
          (item) => `${item.textContent}=${item.getAttribute('data-state')}`,
        ),
      }))
    const saved = async () =>
      JSON.parse(
        ((await page.evaluate(
          () =>
            (window as unknown as { desktopFixture: { settings: string } }).desktopFixture.settings,
        )) as string) || '{}',
      ) as { codeIntelligence?: boolean; languageServers?: Record<string, string> }
    const serverStatus = () =>
      page.evaluate(async () => {
        const response = await fetch(`/r/${location.pathname.split('/')[2]}/api/lsp`)
        return (await response.json()) as {
          enabled: boolean
          languages: { id: string; choice: string }[]
        }
      })

    const settings = await openSettings()
    const before = await poll(
      () => rows(settings),
      (list) => list.every((row) => row.state !== null),
    )
    const typescript = before.find((row) => row.id === 'typescript')
    const go = before.find((row) => row.id === 'go')
    check(
      'Settings name the server this checkout would run',
      typescript?.name === 'TypeScript · tsrs' &&
        typescript.detail.includes('ghl-servers-') &&
        typescript.state === 'idle',
      JSON.stringify(typescript),
    )
    check(
      '  and how to install a missing one',
      go?.state === 'missing' && go.detail.includes('gopls@latest'),
      JSON.stringify(go),
    )
    check('the status bar says nothing while it is off', (await footer()).text === '')

    await settings.evaluate(() =>
      [...document.querySelectorAll<HTMLLabelElement>('label.settings-field')]
        .find((field) => field.textContent?.startsWith('Use language servers'))
        ?.querySelector('input')
        ?.click(),
    )
    const on = await poll(footer, (state) => state.servers.length > 0)
    check(
      'turning it on shows the diff’s server in the status bar',
      on.servers.join() === 'tsrs=idle' && on.text.endsWith('Beta'),
      JSON.stringify(on),
    )
    check(
      '  tells the review server',
      (await poll(serverStatus, (status) => status.enabled)).enabled,
    )
    check(
      '  and is saved',
      (await poll(saved, (stored) => stored.codeIntelligence === true)).codeIntelligence ===
        true,
    )

    await settings.select('.language-server[data-language="typescript"] select', 'off')
    const off = await poll(footer, (state) => state.servers.length === 0)
    check('a language turned off leaves the status bar', off.text === '', JSON.stringify(off))
    const status = await poll(serverStatus, (next) =>
      next.languages.some((language) => language.id === 'typescript' && language.choice === 'off'),
    )
    check(
      '  and the review server',
      status.languages.find((language) => language.id === 'typescript')?.choice === 'off',
      JSON.stringify(status),
    )
    check(
      '  and is saved',
      (await poll(saved, (stored) => stored.languageServers?.typescript === 'off'))
        .languageServers?.typescript === 'off',
    )
    await settings.select('.language-server[data-language="typescript"] select', 'auto')
    await poll(footer, (state) => state.servers.length > 0)
    await settings.close()

    await load('?target=feature')
    const revision = await poll(footer, (state) => state.text !== '')
    check(
      'a revision review says code intelligence needs the working tree',
      revision.text === 'Code intelligence: working tree only',
      JSON.stringify(revision),
    )
  },
} satisfies Suite
