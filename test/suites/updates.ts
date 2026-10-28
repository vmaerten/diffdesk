import type { UpdateSnapshot } from '../../web/src/updates.ts'
import { command, until, type Suite } from '../harness.ts'

const SHEET = 'dialog.update-sheet[open]'

export default {
  name: 'updates',
  async run({ page, load }, check) {
    await load()
    const publish = (patch: Partial<UpdateSnapshot>) =>
      page.evaluate(`window.desktopFixture.publishUpdate(${JSON.stringify(patch)})`)
    const click = (label: string) =>
      page.evaluate(
        `([...document.querySelectorAll('.update-sheet footer button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})).click()`,
      )
    const evaluateBoolean = async (expression: string) => (await page.evaluate(expression)) === true
    const fixture = (name: string) => page.evaluate(`window.desktopFixture.${name}`)
    const installs = () => fixture('updateInstalls')
    const sheet = (text: string) =>
      until(
        page,
        `document.querySelector(${JSON.stringify(`${SHEET} h2`)})?.textContent === ${JSON.stringify(text)}`,
      )
    const closed = () => until(page, `!document.querySelector(${JSON.stringify(SHEET)})`)
    /** Run a command from ⌘K, by its label. */
    const palette = async (search: string, label: string) => {
      await command(page, 'palette')
      await page.waitForSelector('dialog.command-palette[open] .palette-input')
      await page.keyboard.type(search)
      return until(
        page,
        `(() => {
          const item = [...document.querySelectorAll('.palette-item')].find((e) => e.querySelector('.palette-label').textContent === ${JSON.stringify(label)})
          item?.click()
          return !!item
        })()`,
      )
    }

    check('no update means no sheet', (await page.$(SHEET)) === null)
    await evaluateBoolean(
      `window.updateReviewBefore = document.querySelector('.desktop-review .app')`,
    )
    // Keep a real, unsaved inline comment open while the updater publishes.
    const gutter = await page.evaluate(() => {
      const root = document.querySelector('.diff diffs-container')?.shadowRoot
      const cell = root?.querySelector('[data-gutter]')?.getBoundingClientRect()
      return cell ? { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 } : null
    })
    if (!gutter) throw new Error('no comment gutter')
    await page.mouse.move(gutter.x, gutter.y)
    await page.waitForFunction(
      () =>
        !!document
          .querySelector('.diff diffs-container')
          ?.shadowRoot?.querySelector('[data-utility-button]'),
    )
    const plus = await page.evaluate(() => {
      const rect = document
        .querySelector('.diff diffs-container')!
        .shadowRoot!.querySelector('[data-utility-button]')!
        .getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await page.mouse.click(plus.x, plus.y)
    await page.waitForSelector('.comment-composer textarea')
    await page.type('.comment-composer textarea', 'keep this unsaved review draft')
    const notes =
      '### Features\n\n- Read **release notes** before updating.\n- Keep `drafts` open. ([#123](https://github.com/vmaerten/diffdesk/pull/123))\n\n<script>window.releaseNotesExecuted = true</script>\n\n![remote image](https://example.invalid/tracker.png)\n\n[unsafe](javascript:alert(1))'
    await publish({ status: 'available', version: '0.6.1', manager: 'Homebrew', notes })
    check(
      'a new version opens the update sheet',
      await sheet('A new version of Diffdesk is available'),
    )
    check(
      'the sheet takes the focus on its notes, where no key installs',
      await evaluateBoolean(`document.activeElement?.classList.contains('update-sheet-notes')`),
    )
    check(
      'the review and draft stay mounted',
      await evaluateBoolean(
        `window.updateReviewBefore === document.querySelector('.desktop-review .app') && document.querySelector('.comment-composer textarea').value === 'keep this unsaved review draft'`,
      ),
    )
    await page.waitForSelector('.update-sheet-notes li strong')
    check(
      'release notes show headings, lists, emphasis and code before installing',
      (await evaluateBoolean(
        `document.querySelector('.update-sheet-notes h3').textContent === 'Features' && document.querySelector('.update-sheet-notes strong').textContent === 'release notes' && document.querySelector('.update-sheet-notes code').textContent === 'drafts'`,
      )) && (await installs()) === 0,
    )
    check(
      'release links open outside the review',
      await evaluateBoolean(
        `document.querySelector('.update-sheet-notes a[href="https://github.com/vmaerten/diffdesk/pull/123"]').target === '_blank'`,
      ),
    )
    check(
      'release Markdown cannot inject HTML or remote images',
      await evaluateBoolean(
        `!document.querySelector('.update-sheet-notes script, .update-sheet-notes img, .update-sheet-notes [href^="javascript:"]') && !window.releaseNotesExecuted`,
      ),
    )
    check(
      'the sheet explains draft loss before restarting',
      await evaluateBoolean(
        `document.querySelector('.update-sheet-note').textContent.includes('Unsaved drafts')`,
      ),
    )
    await click('Remind Me Later')
    check(
      'Remind Me Later hides the sheet without installing',
      (await closed()) && (await installs()) === 0 && (await fixture('updateDismissals')) === 0,
    )
    check(
      'the draft gets the focus back',
      await evaluateBoolean(
        'document.activeElement === document.querySelector(".comment-composer textarea")',
      ),
    )

    check(
      '⌘K offers the hidden update',
      (await palette('update', 'Update to 0.6.1 and Restart…')) &&
        (await sheet('A new version of Diffdesk is available')),
    )
    await page.keyboard.press('Escape')
    check(
      'Escape hides the offer too',
      (await closed()) &&
        (await installs()) === 0 &&
        (await evaluateBoolean(
          `document.querySelector('.comment-composer textarea').value === 'keep this unsaved review draft'`,
        )),
    )
    await palette('update', 'Update to 0.6.1 and Restart…')
    await sheet('A new version of Diffdesk is available')
    await click('Skip This Version')
    check(
      'Skip This Version tells Go and closes the sheet',
      (await closed()) && (await fixture('updateSkips')) === 1 && (await installs()) === 0,
    )

    const long = Array.from({ length: 80 }, (_, i) => `- Change number ${i + 1}`).join('\n')
    await publish({ status: 'available', version: '0.6.1', manager: 'Homebrew', notes: long })
    await sheet('A new version of Diffdesk is available')
    await page.setViewport({ width: 800, height: 600 })
    await page.waitForSelector('.update-sheet-notes li')
    const fits = await page.evaluate(() => {
      const box = document.querySelector('.update-sheet-notes')!
      const bounds = document.querySelector('.update-sheet')!.getBoundingClientRect()
      return (
        box.scrollHeight > box.clientHeight &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight &&
        [...document.querySelectorAll('.update-sheet footer button')].every((button) => {
          const rect = button.getBoundingClientRect()
          return (
            rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom
          )
        })
      )
    })
    check('a long changelog scrolls, and the buttons fit the minimum window', fits)
    await page.setViewport({ width: 1280, height: 800 })

    await publish({ notes })
    await click('Update and Restart')
    check(
      'Update and Restart starts one installation with honest progress',
      (await sheet('Updating to Diffdesk 0.6.1…')) &&
        (await installs()) === 1 &&
        (await page.$('[role="progressbar"]:not([aria-valuenow])')) !== null,
    )
    check(
      'installation cannot be dismissed or started twice',
      (await page.$('.update-sheet footer button')) === null,
    )
    await page.keyboard.press('Escape')
    check('Escape does not hide an installation', await sheet('Updating to Diffdesk 0.6.1…'))
    await page.reload({ waitUntil: 'networkidle0' })
    check(
      'reload recovers the ongoing native operation, with its notes',
      (await sheet('Updating to Diffdesk 0.6.1…')) &&
        (await installs()) === 0 &&
        (await until(
          page,
          `document.querySelector('.update-sheet-notes strong')?.textContent === 'release notes'`,
        )),
    )
    // A delayed event must not replace the newer status read after reload.
    await publish({ revision: 1, status: 'available', version: '0.5.0' })
    check(
      'an older event cannot overwrite installation',
      await sheet('Updating to Diffdesk 0.6.1…'),
    )

    await publish({
      status: 'error',
      message: 'Homebrew has not installed Diffdesk 0.6.1 yet.',
      retry: 'install',
    })
    check('install failure stays in the sheet', await sheet('The update couldn’t be completed'))
    await page.click('.update-details summary')
    check(
      'error details explain the failure',
      await evaluateBoolean(
        `document.querySelector('.update-details pre').textContent.includes('Homebrew has not installed')`,
      ),
    )
    await click('Try Again')
    check(
      'retry repeats installation, without another check',
      (await sheet('Updating to Diffdesk 0.6.1…')) &&
        (await installs()) === 1 &&
        (await fixture('updateChecks')) === 0,
    )
    await publish({ status: 'restarting', message: '', retry: '' })
    check('successful installation announces restart', await sheet('Restarting Diffdesk…'))

    await publish({ status: 'error', message: 'GitHub is offline', retry: 'check' })
    await page.waitForSelector('.update-sheet footer .primary')
    await click('Try Again')
    check(
      'a failed check retries checking, not installing',
      (await sheet('Checking for Updates…')) &&
        (await fixture('updateChecks')) === 1 &&
        (await installs()) === 1,
    )
    await publish({ status: 'current', version: '0.6.1', message: '', retry: '' })
    check('manual check reports an up-to-date version', await sheet('You’re up to date'))
    await click('OK')
    await closed()
    check(
      '⌘K checks for updates',
      (await palette('check for', 'Check for Updates…')) &&
        (await sheet('Checking for Updates…')) &&
        (await fixture('updateChecks')) === 2,
    )
    await publish({ status: 'available', version: '0.6.2', manager: 'mise', retry: '', notes: '' })
    check(
      'a release without notes offers its GitHub release page',
      await until(
        page,
        `document.querySelector('.update-sheet-notes a')?.href === 'https://github.com/vmaerten/diffdesk/releases/tag/v0.6.2'`,
      ),
    )
    check(
      'mise updates explain global selection and project pins',
      await evaluateBoolean(
        `[...document.querySelectorAll('.update-sheet-note')].some((note) => note.textContent.includes('Project version pins'))`,
      ),
    )

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await publish({ status: 'installing' })
    await sheet('Updating to Diffdesk 0.6.2…')
    check(
      'progress respects reduced motion',
      await evaluateBoolean(
        `getComputedStyle(document.querySelector('.update-progress span')).animationName === 'none'`,
      ),
    )
    await page.evaluate(() => window.go!.main.desktopApp.CloseTab('1'))
    check(
      'updates remain visible on the welcome screen',
      await until(
        page,
        `!!document.querySelector('.desktop-empty') && !!document.querySelector(${JSON.stringify(SHEET)})`,
      ),
    )
  },
} satisfies Suite
