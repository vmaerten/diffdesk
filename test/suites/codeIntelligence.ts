import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import type { Page } from 'puppeteer-core'

import { installDesktopRuntime } from '../desktopRuntime.ts'
import { clickTreeRow, command, poll, sleep, type Suite } from '../harness.ts'

const SELECTED_TEXT = `(() => {
  for (const host of document.querySelectorAll('.diff diffs-container')) {
    const lines = host.shadowRoot?.querySelectorAll('[data-selected-line]') ?? []
    const text = [...lines].map((line) => line.textContent ?? '').join(' ')
    if (text) return text
  }
  return ''
})()`

const SCROLL_SETTLE = 400

/** Uses engine_3, whose definition the diff shows, and parser_2, whose it does not. */
const INDEX = [
  "import { engine_3 } from './core/engine'",
  "import { parser_2 } from './core/parser'",
  '',
  'export const answer = engine_3 + parser_2',
  'export const twice = answer * 2',
  '// engine_3 comes from the core',
  '',
].join('\n')

/** The Symbol panel checkbox: whether it is ticked, after clicking it if asked. */
const symbolPanelSetting = (window: Page, click: boolean) =>
  window.evaluate((toggle) => {
    const input = [...document.querySelectorAll<HTMLLabelElement>('label.settings-field')]
      .find((field) => field.textContent?.startsWith('Symbol panel'))
      ?.querySelector('input')
    if (toggle) input?.click()
    return input?.checked ?? null
  }, click)

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
  async run({ page, load, repoPath, errors }, check) {
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
        [...document.querySelectorAll('.language-server')].map((item) => ({
          id: item.getAttribute('data-language') ?? '',
          name: item.querySelector('.settings-label > span')?.textContent ?? '',
          detail: item.querySelector('.settings-label small')?.textContent ?? '',
          state: item.querySelector('.server-state')?.getAttribute('data-state') ?? null,
          choice: item.querySelector('select')?.value ?? '',
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

    const diagnostics = async () => {
      await command(page, 'palette')
      await page.waitForSelector('dialog.command-palette[open] .palette-input')
      await page.type('.palette-input', 'IntelliSense')
      await page.waitForSelector('.palette-item[data-selected="true"]')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.intelligence-sheet[open]')
      await page.waitForSelector('.intelligence-servers [data-language]')
      return page.$eval('.intelligence-sheet', (element) => element.textContent ?? '')
    }

    const disabledDiagnostic = await diagnostics()
    check(
      'the palette diagnoses disabled code intelligence and missing servers',
      disabledDiagnostic.includes('IntelliSense is off') &&
        disabledDiagnostic.includes('gopls@latest') &&
        disabledDiagnostic.includes('Working treeIncluded'),
      disabledDiagnostic,
    )
    await page.keyboard.press('Escape')

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
        typescript.detail.includes('diffdesk-servers-') &&
        typescript.state === 'idle',
      JSON.stringify(typescript),
    )
    check(
      '  and how to install a missing one',
      go?.state === 'missing' && go.detail.includes('gopls@latest'),
      JSON.stringify(go),
    )
    check('the status bar says nothing while it is off', (await footer()).text === '')

    await diagnostics()
    await page.click('.intelligence-blocker button')
    const on = await poll(footer, (state) => state.servers.length > 0)
    await page.keyboard.press('Escape')
    check(
      'Turn On in IntelliSense shows the diff’s server in the status bar',
      on.servers.join() === 'tsrs=idle' && on.text.endsWith('Beta'),
      JSON.stringify(on),
    )
    check(
      '  tells the review server',
      (await poll(serverStatus, (status) => status.enabled)).enabled,
    )
    check(
      '  and is saved',
      (await poll(saved, (stored) => stored.codeIntelligence === true)).codeIntelligence === true,
    )

    check(
      '  and the open Settings window follows',
      await poll(
        () =>
          settings.evaluate(
            () =>
              [...document.querySelectorAll<HTMLLabelElement>('label.settings-field')]
                .find((field) => field.textContent?.startsWith('Use language servers'))
                ?.querySelector('input')?.checked === true,
          ),
        (checked) => checked,
      ),
    )
    await settings.select('.language-server[data-language="typescript"] select', 'off')
    const off = await poll(footer, (state) => state.servers.length === 0)
    check('a language turned off leaves the status bar', off.text === '', JSON.stringify(off))
    const offDiagnostic = await diagnostics()
    check(
      'diagnostics keep disabled languages visible',
      await page.$eval(
        '.intelligence-servers [data-language="typescript"]',
        (element) => element.getAttribute('data-state') === 'off',
      ),
      offDiagnostic,
    )
    await page.keyboard.press('Escape')
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
        .codeIntelligence === true,
    )
    await settings.select('.language-server[data-language="typescript"] select', 'auto')
    await poll(footer, (state) => state.servers.length > 0)
    // Saved after a pause: the next page reads what was saved.
    await poll(saved, (stored) => stored.languageServers?.typescript === 'auto')
    await settings.close()

    await load('?target=feature')
    const revision = await poll(footer, (state) => state.text !== '')
    check(
      'a revision review offers code intelligence in an isolated copy',
      revision.text.includes('Revision copy') && revision.servers.length > 0,
      JSON.stringify(revision),
    )
    const revisionDiagnostic = await diagnostics()
    check(
      'diagnostics identify the isolated revision without changing the checkout',
      revisionDiagnostic.includes('Checkoutmain') &&
        revisionDiagnostic.includes('Targetfeature') &&
        revisionDiagnostic.includes('Working treeExcluded') &&
        revisionDiagnostic.includes('Isolated revision') &&
        revisionDiagnostic.includes('diffdesk-intelligence-'),
      revisionDiagnostic,
    )
    await page.keyboard.press('Escape')

    // index.ts uses engine_3, whose definition the diff shows, and parser_2, whose it does not.
    writeFileSync(join(repoPath, 'src/index.ts'), INDEX)
    writeFileSync(
      join(repoPath, 'src/core/engine.ts'),
      `${Array.from({ length: 60 }, (_, i) => `${i === 3 ? 'export ' : ''}const engine_${i} = ${i}`).join('\n')}\n`,
    )
    await load('')
    await clickTreeRow(page, 'src/index.ts')
    // The diff takes pointer events again only once it stops scrolling.
    await sleep(SCROLL_SETTLE)

    /** The centre of a token on the screen, from the file whose header names path. */
    const token = (path: string, line: number, text: string, type = 'change-addition') =>
      page.evaluate(
        (wanted) => {
          for (const host of document.querySelectorAll('.diff diffs-container')) {
            const root = host.shadowRoot
            if (!root?.querySelector('[data-diffs-header]')?.textContent?.includes(wanted.path))
              continue
            const lines = root.querySelectorAll(
              `[data-line="${wanted.line}"][data-line-type="${wanted.type}"]`,
            )
            for (const row of lines) {
              const found = [...row.querySelectorAll('[data-char]')].find(
                (element) => element.textContent === wanted.text,
              )
              if (!found) continue
              const rect = found.getBoundingClientRect()
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            }
          }
          return null
        },
        { path, line, text, type },
      )
    const card = () =>
      page.evaluate(() => {
        const shown = document.querySelector('.symbol-card')
        if (!shown) return null
        return {
          signature: shown.querySelector('.symbol-signature')?.textContent ?? '',
          meta: shown.querySelector('.symbol-card-meta')?.textContent ?? '',
          snippet: shown.querySelector('.symbol-snippet')?.textContent ?? '',
          status: shown.querySelector('.symbol-card-status')?.textContent ?? '',
        }
      })
    const actions = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.symbol-card-actions button')].map(
          (button) => button.textContent,
        ),
      )
    /** The underline's width, or null when nothing is underlined. */
    const underlined = () =>
      page.evaluate(
        () => document.querySelector('.symbol-underline')?.getBoundingClientRect().width ?? null,
      )
    /** The centre of a word inside a line's text, whatever tokens hold it. */
    const wordPoint = (path: string, line: number, word: string) =>
      page.evaluate(
        (wanted) => {
          for (const host of document.querySelectorAll('.diff diffs-container')) {
            const root = host.shadowRoot
            if (!root?.querySelector('[data-diffs-header]')?.textContent?.includes(wanted.path))
              continue
            const row = root.querySelector(
              `[data-line="${wanted.line}"][data-line-type="change-addition"]`,
            )
            const walker = row && document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
            for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
              const at = node.textContent?.indexOf(wanted.word) ?? -1
              if (at < 0) continue
              const range = document.createRange()
              range.setStart(node, at)
              range.setEnd(node, at + wanted.word.length)
              const rect = range.getBoundingClientRect()
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width }
            }
          }
          return null
        },
        { path, line, word },
      )

    const engine = await token('src/index.ts', 4, 'engine_3')
    check('a working-tree review shows its symbols as tokens', engine !== null)
    if (!engine) return
    await page.mouse.move(engine.x, engine.y)
    await sleep(400)
    check('without ⌘, hovering a symbol opens nothing', (await card()) === null)
    await page.keyboard.down('Meta')
    const opened = await poll(card, (state) => Boolean(state?.signature))
    check(
      'holding ⌘ over a symbol opens its card',
      opened?.signature === 'const engine_3: number' &&
        opened.meta.includes('src/core/engine.ts:4') &&
        !opened.meta.includes('not in this diff'),
      JSON.stringify(opened),
    )
    check(
      '  offering to go to a definition the diff shows',
      (await actions()).includes('Go to definition ⌘ click'),
      JSON.stringify(await actions()),
    )
    check('  and underlines it', ((await underlined()) ?? 0) > 0)
    check(
      '  and the status bar shows its server running',
      (await poll(footer, (state) => state.servers.join() === 'tsrs=ready')).servers.join() ===
        'tsrs=ready',
    )

    await page.mouse.click(engine.x, engine.y)
    const jumped = (await poll(
      () => page.evaluate(SELECTED_TEXT),
      (text) => String(text).includes('export const engine_3 = 3'),
    )) as string
    check(
      '⌘-click selects a definition the diff shows',
      jumped.includes('export const engine_3 = 3'),
      jumped,
    )
    check('  and closes the card', (await card()) === null)
    await page.keyboard.press('[')
    const returned = (await poll(
      () => page.evaluate(SELECTED_TEXT),
      (text) => String(text).includes('engine_3 + parser_2'),
    )) as string
    check('⌘[ goes back to the symbol', returned.includes('engine_3 + parser_2'), returned)
    await sleep(SCROLL_SETTLE)

    const parser = await token('src/index.ts', 4, 'parser_2')
    if (parser) await page.mouse.click(parser.x, parser.y)
    const outside = await poll(card, (state) => Boolean(state?.snippet))
    check(
      '⌘-click on a symbol defined outside the diff shows its code in the card, in place of the hover’s',
      outside?.snippet.includes('const parser_2 = 2') === true &&
        outside.signature === '' &&
        outside.meta.includes('src/core/parser.ts:3') &&
        outside.meta.includes('not in this diff'),
      JSON.stringify(outside),
    )
    check(
      '  with nothing left to open once its code shows',
      !(await actions()).some((label) => label?.includes('definition')),
      JSON.stringify(await actions()),
    )
    const coloured = await poll(
      () =>
        page.evaluate(
          () =>
            document.querySelectorAll('.symbol-card .symbol-snippet span[style*="color"]').length,
        ),
      (count) => count > 0,
    )
    check('  in the review’s syntax colours', coloured > 0, String(coloured))
    await page.keyboard.up('Meta')
    await page.keyboard.press('Escape')
    check('Escape closes the card', (await poll(card, (state) => state === null)) === null)

    // A comment is one token: the name under the pointer is found inside it.
    const inComment = await wordPoint('src/index.ts', 6, 'engine_3')
    if (inComment) await page.mouse.move(inComment.x, inComment.y)
    await page.keyboard.down('Meta')
    const commented = await poll(card, (state) => Boolean(state?.signature))
    const width = await underlined()
    check(
      'a name inside a longer token is looked up, and underlined alone',
      commented?.signature === 'const engine_3: number' &&
        inComment !== null &&
        width !== null &&
        Math.abs(width - inComment.width) < 2,
      JSON.stringify({ commented, width, inComment }),
    )
    await page.keyboard.up('Meta')
    await page.keyboard.press('Escape')
    await poll(card, (state) => state === null)

    const deleted = await token('src/index.ts', 1, 'index_0', 'change-deletion')
    await page.keyboard.down('Meta')
    if (deleted) await page.mouse.move(deleted.x, deleted.y)
    await sleep(400)
    check(
      'a deleted line is not looked up: the disk no longer has it',
      deleted !== null && (await card()) === null && (await underlined()) === null,
    )
    await page.keyboard.up('Meta')

    // Changed under the review: the lines on screen no longer match the disk.
    writeFileSync(join(repoPath, 'src/index.ts'), '// moved\nexport const twice = 2\n')
    const twice = await token('src/index.ts', 5, 'twice')
    if (twice) await page.mouse.move(twice.x, twice.y)
    await page.keyboard.down('Meta')
    const stale = await poll(card, (state) =>
      Boolean(state?.status && !state.status.startsWith('Asking')),
    )
    check(
      'a file changed on disk asks for a refresh instead of answering',
      stale?.status.includes('changed on disk') === true,
      JSON.stringify(stale),
    )
    await page.keyboard.up('Meta')

    // The Symbol tab: engine_3 is used in index.ts, in the diff, and in an untracked
    // extra.ts, which the diff leaves out.
    writeFileSync(join(repoPath, 'src/index.ts'), INDEX)
    writeFileSync(
      join(repoPath, 'src/extra.ts'),
      "import { engine_3 } from './core/engine'\nexport const extra = engine_3\n",
    )
    const symbolSettings = await openSettings()
    check(
      'Settings offer the Symbol panel, on by default',
      (await symbolPanelSetting(symbolSettings, false)) === true,
    )
    await symbolSettings.close()
    await load('')
    await clickTreeRow(page, 'src/index.ts')
    await sleep(SCROLL_SETTLE)
    const panel = () =>
      page.evaluate(() => {
        const shown = document.querySelector('.symbol-panel:not([hidden])')
        return {
          open: shown !== null,
          comments: document.querySelector('#comments-panel:not([hidden])') !== null,
          tab: document.querySelector('.panel-tabs [aria-selected="true"]')?.textContent ?? null,
          name: shown?.querySelector('.symbol-panel-name b')?.textContent ?? '',
          location: shown?.querySelector('.symbol-panel-location')?.textContent ?? '',
          groups: [...(shown?.querySelectorAll('.symbol-references') ?? [])].map(
            (group) =>
              `${group.getAttribute('aria-label')}:${group.querySelectorAll('.symbol-reference').length}`,
          ),
          inDiff: shown?.querySelectorAll('.symbol-reference .symbol-tag').length ?? 0,
        }
      })
    const references = await token('src/index.ts', 4, 'engine_3')
    if (references) await page.mouse.move(references.x, references.y)
    await page.keyboard.down('Meta')
    await poll(card, (state) => Boolean(state?.signature))
    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.symbol-card-actions button')]
        .find((button) => button.textContent === 'References')
        ?.click(),
    )
    await page.keyboard.up('Meta')
    const listed = await poll(panel, (state) => state.groups.length > 0)
    check(
      'References opens the Symbol tab with the definition',
      listed.open &&
        listed.tab === 'Symbol' &&
        listed.name === 'engine_3' &&
        listed.location === 'src/core/engine.ts:4',
      JSON.stringify(listed),
    )
    check(
      '  and the references by file, those in the diff marked',
      listed.groups.join() === 'src/extra.ts:2,src/index.ts:3' && listed.inDiff === 3,
      JSON.stringify(listed),
    )
    const panelWidth = () =>
      page.evaluate(
        () =>
          document.querySelector('.symbol-panel:not([hidden])')?.getBoundingClientRect().width ?? 0,
      )
    const narrow = await panelWidth()
    const handle = await page.$('.panel-resizer')
    const box = await handle?.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 4 })
      await page.mouse.up()
    }
    const widened = await poll(panelWidth, (size) => size > narrow + 100)
    check(
      'the side panel widens as its handle moves left',
      Math.abs(widened - narrow - 120) < 4,
      JSON.stringify({ narrow, widened }),
    )
    await page.click('.symbol-panel-references-head input')
    const filtered = await poll(panel, (state) => state.groups.length === 1)
    check(
      'In this diff only leaves the references the diff shows',
      filtered.groups.join() === 'src/index.ts:3',
      JSON.stringify(filtered),
    )
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('.symbol-reference:not(:disabled)')?.click(),
    )
    const shownReference = (await poll(
      () => page.evaluate(SELECTED_TEXT),
      (text) => String(text).includes('import { engine_3 }'),
    )) as string
    check(
      'a reference in the diff opens there',
      shownReference.includes('import { engine_3 }'),
      shownReference,
    )

    await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.panel-tabs button')]
        .find((button) => button.textContent?.startsWith('Comments'))
        ?.click(),
    )
    const commentsTab = await poll(panel, (state) => state.comments)
    check('the Comments tab shows the comments', commentsTab.comments && !commentsTab.open)
    await page.click('.comments-trigger')
    check(
      '  and the Comments button then closes the panel',
      !(await poll(panel, (state) => !state.comments)).comments,
    )

    const offSettings = await openSettings()
    await symbolPanelSetting(offSettings, true)
    await poll(saved, (stored) => (stored as { symbolPanel?: boolean }).symbolPanel === false)
    await offSettings.close()
    const again = await token('src/index.ts', 4, 'engine_3')
    if (again) await page.mouse.move(again.x, again.y)
    await page.keyboard.down('Meta')
    await poll(card, (state) => Boolean(state?.signature))
    const offered = await actions()
    await page.keyboard.up('Meta')
    await page.keyboard.press('Escape')
    await page.click('.comments-trigger')
    check(
      'turning the Symbol panel off removes References and the tabs',
      offered.join() === 'Go to definition ⌘ click' && (await page.$('.panel-tabs')) === null,
      JSON.stringify(offered),
    )

    const firstCommit = execFileSync('git', ['rev-list', '--reverse', 'main..feature'], {
      cwd: repoPath,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0]!
    const checkoutText = readFileSync(join(repoPath, 'src/index.ts'), 'utf8')
    for (const scope of [
      { query: '?target=feature', path: 'src/core/cache.ts', line: 30, name: 'cache_29' },
      { query: '?target=other', path: 'src/index.ts', line: 33, name: 'index_32' },
      {
        query: `?target=feature&commit=${firstCommit}`,
        path: 'src/core/engine.ts',
        line: 70,
        name: 'engine_69',
      },
    ]) {
      await load(scope.query)
      await clickTreeRow(page, scope.path)
      await sleep(SCROLL_SETTLE)
      const at = await poll(() => token(scope.path, scope.line, scope.name), Boolean)
      check(`revision ${scope.query} shows its symbol`, at !== null)
      if (!at) continue
      const request = page.waitForRequest((candidate) =>
        candidate.url().includes('/api/lsp/symbol?'),
      )
      await page.keyboard.down('Meta')
      await page.mouse.move(at.x, at.y)
      const found = await poll(card, (state) => state?.signature === `const ${scope.name}: number`)
      const sent = new URL((await request).url())
      const comparison = await page.evaluate(
        async () =>
          (await (await fetch(location.pathname + '/api/diff' + location.search)).json())
            .comparison,
      )
      check(
        `IntelliSense answers on ${scope.query}`,
        found?.signature === `const ${scope.name}: number` && found.meta.includes(scope.path),
        JSON.stringify(found),
      )
      check(
        'the lookup is pinned to the displayed commit',
        sent.searchParams.get('revision') === comparison.after,
      )
      await page.keyboard.up('Meta')
      await page.keyboard.press('Escape')
    }
    check(
      'switching analysis revisions leaves the actual checkout and its edits intact',
      execFileSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim() === 'main' && readFileSync(join(repoPath, 'src/index.ts'), 'utf8') === checkoutText,
    )

    // The server's 409 is the answer under test; Chrome logs any 4xx as a console error.
    const conflict = errors.findIndex((error) => error.includes('status of 409'))
    if (conflict >= 0) errors.splice(conflict, 1)
  },
} satisfies Suite
