import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sleep, topbar, TREE_ROWS, type Suite, type TreeRow } from '../harness.ts'

const BUTTON = `document.querySelector('.revision .toggle button.untracked')`

export default {
  name: 'untracked',
  async run({ page, load, repoPath }, check) {
    const stray = join(repoPath, 'ut-stray.ts')

    /** The second toggle in the revision group, which is this one. */
    const button = async () => (await topbar(page)).toggles.at(-1)
    const row = async () => {
      const { rows } = (await page.evaluate(TREE_ROWS)) as { rows: TreeRow[] }
      return rows.find((r) => r.path === 'ut-stray.ts') ?? null
    }
    const message = () =>
      page.evaluate(`document.querySelector('.message')?.textContent?.trim() ?? null`) as Promise<
        string | null
      >
    const warnings = () =>
      page.evaluate(
        `[...document.querySelectorAll('.warning')].map((e) => e.textContent.trim()).join(' | ')`,
      ) as Promise<string>
    /** The topbar's count, from `totals`, against the sidebar's, from the rows. */
    const counts = () =>
      page.evaluate(`[
        document.querySelector('.stats')?.textContent?.trim().split(' ')[0] ?? null,
        document.querySelector('.sidebar-head span')?.textContent?.trim().split(' ')[0] ?? null,
      ]`) as Promise<[string | null, string | null]>

    try {
      // Three lines, so a row reading `+0` is a failure and not a coincidence.
      // The fixture is clean and sits on its own trunk, so this file is the
      // whole of what the bare URL has to show — or would have, were it in.
      writeFileSync(stray, 'export const a = 1\nexport const b = 2\nexport const c = 3\n')

      // Pressed first: released, the diff is empty and there is no tree to wait
      // for, which is what `load` waits on.
      await load('?untracked=1')
      await sleep(1000)

      check(
        'the file is in the diff with the flag on',
        (await row()) !== null && (await button())?.pressed === true,
        JSON.stringify(await button()),
      )
      // `+3` and not `+0`: `numstat` never saw this file, so its counts have to
      // come from the reading that synthesised its patch.
      check(
        '  carrying the counts git gives it, and the untracked status',
        (await row())?.status === 'untracked' && (await row())?.decoration.includes('+3') === true,
        JSON.stringify(await row()),
      )
      // The topbar counts `totals`, the sidebar counts the rows on screen: they
      // agree only if the untracked file reached `files` as well as the patch.
      const [head, side] = await counts()
      check('  and the two file counts agree', head === side && head === '1', `${head} vs ${side}`)
      check(
        '  which the button says with its label',
        (await button())?.label === 'Untracked (1)',
        JSON.stringify(await button()),
      )

      await page.evaluate(`${BUTTON}.click()`)
      await sleep(1500)

      check(
        'releasing it takes the file back out',
        (await row()) === null && (await button())?.pressed === false,
        JSON.stringify(await button()),
      )
      check(
        '  keeping the count on the label, where the banner used to be',
        (await button())?.label === 'Untracked (1)' && (await warnings()) === '',
        `${JSON.stringify(await button())} | warnings: ${(await warnings()) || 'none'}`,
      )
      // "matches the base" would be a lie: the file is there, and it is this
      // button that keeps it out.
      check(
        '  and the empty message naming what is being hidden',
        (await message())?.includes('nothing but 1 untracked file(s)') === true,
        (await message()) ?? 'no message',
      )
      check(
        '  and the URL dropping the parameter, which is where the state lives',
        !(await topbar(page)).search.includes('untracked'),
        (await topbar(page)).search || 'no query',
      )

      // Bare, as it is typed by hand: `get` would return the empty string here,
      // which is falsy, and the flag would be inert without saying so.
      await load('?untracked')
      await sleep(1000)
      check(
        'the flag works written bare',
        (await button())?.pressed === true && (await row()) !== null,
        JSON.stringify(await button()),
      )

      // A ref holds no working tree, so nothing is untracked in it whatever the
      // flag says — and a pressed button there would claim otherwise.
      await load('?target=feature&untracked=1')
      await sleep(1000)
      const onRef = await button()
      check(
        'reviewing a ref disables it, unpressed and without a count',
        onRef?.off === true && onRef?.pressed === false && onRef?.label === 'Untracked',
        JSON.stringify(onRef),
      )
    } finally {
      rmSync(stray, { force: true })
    }
  },
} satisfies Suite
