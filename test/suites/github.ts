import { settled, until, type Suite } from '../harness.ts'

/**
 * The server's gh is test/fakeGh.ts: `stack/b` has an open pull request whose
 * head is one commit behind the branch, approved by bob, with a failing check;
 * others have none.
 */
export default {
  name: 'github',
  async run({ page, load }, check) {
    const pill = () =>
      page.evaluate(() => {
        const button = document.querySelector('.pr-pill')
        return (
          button && { text: button.textContent ?? '', label: button.getAttribute('aria-label') }
        )
      })

    await load('?target=stack%2Fb')
    await until(page, `document.querySelector('.pr-pill')`)
    const shown = await pill()
    check(
      'a branch with a pull request shows it',
      shown?.text.startsWith('#42') === true,
      shown?.text,
    )
    check(
      '  with its unpushed commit',
      shown?.label === 'Pull request #42, open, 1 check failing, 1 commit not pushed',
      shown?.label ?? '',
    )

    await page.click('.pr-pill')
    await until(page, `document.querySelector('.pr-popover')`)
    const facts = await page.evaluate(() =>
      [...document.querySelectorAll('.pr-facts dd')].map((fact) => fact.textContent),
    )
    check('its popover says who approved', facts[0] === 'Approved by bob', facts.join(' | '))
    check('  and what GitHub lacks', facts[2] === '1 local commit not on GitHub', facts.join(' | '))
    const checks = await page.evaluate(() => ({
      head: document.querySelector('.pr-checks-head')?.textContent,
      shown: [...document.querySelectorAll('.pr-checks > ul .pr-check-name')].map(
        (name) => name.textContent,
      ),
      folded: document.querySelector('.pr-checks summary')?.textContent,
    }))
    check(
      'the failing check is listed with its time',
      checks.shown.join() === 'test / ui' && checks.head?.includes('1 failing · 2 passed') === true,
      `${checks.shown.join()} | ${checks.head}`,
    )
    check('  and the passed ones folded', checks.folded === '2 passed', checks.folded ?? '')
    await page.keyboard.press('Escape')
    check('Escape closes it', await until(page, `!document.querySelector('.pr-popover')`))

    await load('?target=other')
    await settled(page)
    check('a branch without a pull request shows nothing', (await pill()) === null)

    await page.evaluate(() =>
      localStorage.setItem(
        'desktopFixture.settings',
        JSON.stringify({ version: 1, showPullRequests: false }),
      ),
    )
    await load('?target=stack%2Fb')
    await settled(page)
    check('the setting turns it off', (await pill()) === null)

    await page.evaluate(() =>
      localStorage.setItem(
        'desktopFixture.settings',
        JSON.stringify({ version: 1, pullRequestPlace: 'status-bar' }),
      ),
    )
    await load('?target=stack%2Fb')
    await until(page, `document.querySelector('.footer-pr')`)
    const footer = await page.evaluate(
      () => document.querySelector('.footer-pr')?.textContent ?? null,
    )
    check(
      'the status bar can show it instead, in words',
      footer === '#42 Open1 failing1 not pushed' && (await pill()) === null,
      footer ?? '(none)',
    )
    await page.click('.footer-pr')
    await until(page, `document.querySelector('.pr-popover')`)
    const above = await page.evaluate(() => {
      const popover = document.querySelector('.pr-popover')!.getBoundingClientRect()
      const bar = document.querySelector('.review-footer')!.getBoundingClientRect()
      return popover.height > 0 && popover.top >= 0 && popover.bottom <= bar.top
        ? true
        : JSON.stringify({ popover, bar, button: document.querySelector('.footer-pr')!.getBoundingClientRect() })
    })
    check('  and its popover opens above it, uncut', above === true, String(above))
    await page.keyboard.press('Escape')

    // The Settings window saves, and Go hands the change to the review.
    await page.evaluate(() =>
      window.go?.main.desktopApp.SaveSettings(
        JSON.stringify({ version: 1, pullRequestPlace: 'title-bar' }),
      ),
    )
    check(
      'changing the place moves it at once',
      await until(
        page,
        `document.querySelector('.pr-pill') && !document.querySelector('.footer-pr')`,
      ),
    )
  },
} satisfies Suite
