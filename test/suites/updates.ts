import type { UpdateSnapshot } from '../../web/src/updates.ts'
import { until, type Suite } from '../harness.ts'

export default {
  name: 'updates',
  async run({ page, load }, check) {
    await load()
    const publish = (patch: Partial<UpdateSnapshot>) =>
      page.evaluate(`window.desktopFixture.publishUpdate(${JSON.stringify(patch)})`)
    const click = (label: string) =>
      page.evaluate(
        `([...document.querySelectorAll('.update-actions button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})).click()`,
      )
    const evaluateBoolean = async (expression: string) => (await page.evaluate(expression)) === true
    const installs = () => page.evaluate('window.desktopFixture.updateInstalls')
    const banner = (text: string) =>
      until(
        page,
        `document.querySelector('.update-banner h2')?.textContent === ${JSON.stringify(text)}`,
      )

    check('no update means no banner', (await page.$('.update-banner')) === null)
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
      'a new version appears in a nonmodal banner',
      (await banner('Diffdesk 0.6.1 is available')) && (await page.$('dialog[open]')) === null,
    )
    check(
      'the banner does not steal focus from a draft',
      await evaluateBoolean(
        'document.activeElement === document.querySelector(".comment-composer textarea")',
      ),
    )
    check(
      'the review and draft stay mounted',
      await evaluateBoolean(
        `window.updateReviewBefore === document.querySelector('.desktop-review .app') && document.querySelector('.comment-composer textarea').value === 'keep this unsaved review draft'`,
      ),
    )
    await page.click('.update-notes > summary')
    await page.waitForSelector('.update-notes-body li strong')
    check(
      'release notes render headings, lists, emphasis and code before installing',
      (await evaluateBoolean(
        `document.querySelector('.update-notes-body h3').textContent === 'Features' && document.querySelector('.update-notes-body strong').textContent === 'release notes' && document.querySelector('.update-notes-body code').textContent === 'drafts'`,
      )) && (await installs()) === 0,
    )
    check(
      'release links open outside the review',
      await evaluateBoolean(
        `document.querySelector('.update-notes-body a[href="https://github.com/vmaerten/diffdesk/pull/123"]').target === '_blank'`,
      ),
    )
    check(
      'release Markdown cannot inject HTML or remote images',
      await evaluateBoolean(
        `!document.querySelector('.update-notes-body script, .update-notes-body img, .update-notes-body [href^="javascript:"]') && !window.releaseNotesExecuted`,
      ),
    )
    await click('Later')
    check(
      'Later hides the banner without installing',
      (await until(page, '!document.querySelector(".update-banner")')) && (await installs()) === 0,
    )

    await publish({ status: 'available', version: '0.6.1', manager: 'Homebrew' })
    await page.waitForSelector('.update-actions .primary')
    await click('Update…')
    check(
      'Update asks for confirmation before calling Go',
      (await banner('Update and restart Diffdesk?')) && (await installs()) === 0,
    )
    check(
      'confirmation explains draft loss and focuses Cancel',
      await evaluateBoolean(
        `document.querySelector('.update-copy').textContent.includes('Unsaved drafts') && document.activeElement.textContent === 'Cancel'`,
      ),
    )
    await page.keyboard.press('Escape')
    check(
      'Escape cancels only the update confirmation',
      (await banner('Diffdesk 0.6.1 is available')) &&
        (await evaluateBoolean(
          `document.querySelector('.comment-composer textarea').value === 'keep this unsaved review draft'`,
        )) &&
        (await installs()) === 0,
    )
    await click('Update…')
    await click('Cancel')
    check(
      'Cancel returns to the offer',
      (await banner('Diffdesk 0.6.1 is available')) && (await installs()) === 0,
    )
    await click('Update…')
    await click('Update and Restart')
    check(
      'confirmation starts one installation with honest progress',
      (await banner('Updating Diffdesk…')) &&
        (await installs()) === 1 &&
        (await page.$('[role="progressbar"]:not([aria-valuenow])')) !== null,
    )
    check(
      'installation cannot be dismissed or started twice',
      (await page.$('.update-actions button')) === null,
    )
    await page.reload({ waitUntil: 'networkidle0' })
    check(
      'reload recovers the ongoing native operation',
      (await banner('Updating Diffdesk…')) && (await installs()) === 0,
    )
    await page.click('.update-notes > summary')
    check(
      'release notes survive a reload during installation',
      await until(
        page,
        `document.querySelector('.update-notes-body strong')?.textContent === 'release notes'`,
      ),
    )
    // A delayed event must not replace the newer status read after reload.
    await publish({ revision: 1, status: 'available', version: '0.5.0' })
    check('an older event cannot overwrite installation', await banner('Updating Diffdesk…'))

    await publish({
      status: 'error',
      message: 'Homebrew has not installed Diffdesk 0.6.1 yet.',
      retry: 'install',
    })
    check('install failure stays in the banner', await banner('The update couldn’t be completed'))
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
      (await banner('Updating Diffdesk…')) &&
        (await installs()) === 1 &&
        (await page.evaluate('window.desktopFixture.updateChecks')) === 0,
    )
    await publish({ status: 'restarting', message: '', retry: '' })
    check('successful installation announces restart', await banner('Restarting Diffdesk…'))

    await publish({ status: 'error', message: 'GitHub is offline', retry: 'check' })
    await page.waitForSelector('.update-actions .primary')
    await click('Try Again')
    check(
      'a failed check retries checking, not installing',
      (await banner('Checking for updates…')) &&
        (await page.evaluate('window.desktopFixture.updateChecks')) === 1 &&
        (await installs()) === 1,
    )
    await publish({ status: 'current', version: '0.6.1', message: '', retry: '' })
    check('manual check reports an up-to-date version', await banner('You’re up to date'))
    await click('Dismiss')
    await publish({ status: 'available', version: '0.6.2', manager: 'mise', retry: '', notes: '' })
    await page.waitForSelector('.update-actions .primary')
    await page.click('.update-notes > summary')
    check(
      'a release without notes offers its GitHub release page',
      await until(
        page,
        `document.querySelector('.update-notes-body a')?.href === 'https://github.com/vmaerten/diffdesk/releases/tag/v0.6.2'`,
      ),
    )
    await click('Update…')
    check(
      'mise confirmation explains global selection and project pins',
      await evaluateBoolean(
        `document.querySelector('.update-note').textContent.includes('Project version pins')`,
      ),
    )

    await page.setViewport({ width: 800, height: 600 })
    const fits = await page.evaluate(() => {
      const bounds = document.querySelector('.update-banner')!.getBoundingClientRect()
      return (
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top > 38 &&
        bounds.bottom < innerHeight &&
        [...document.querySelectorAll('.update-actions button')].every((button) => {
          const rect = button.getBoundingClientRect()
          return (
            rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom
          )
        })
      )
    })
    check('confirmation fits the minimum desktop window', fits)
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await publish({ status: 'installing' })
    await banner('Updating Diffdesk…')
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
        `!!document.querySelector('.desktop-empty') && !!document.querySelector('.update-banner')`,
      ),
    )
  },
} satisfies Suite
