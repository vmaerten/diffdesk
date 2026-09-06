import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { sleep, topbar, type Suite } from '../harness.ts'

/** Named, since the revision group holds a second toggle beside it. */
const BUTTON = `document.querySelector('.revision .toggle button.worktree')`

export default {
  name: 'worktree',
  async run({ page, load, repoPath }, check) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath })
    const staged = join(repoPath, 'wt-staged.ts')
    const untracked = join(repoPath, 'wt-untracked.ts')

    const button = () =>
      page.evaluate(`(() => {
        const b = ${BUTTON}
        return b ? { pressed: b.getAttribute('aria-pressed'), off: b.disabled } : null
      })()`) as Promise<{ pressed: string; off: boolean } | null>
    const files = () =>
      page.evaluate(
        `document.querySelector('.sidebar-head span')?.textContent?.trim() ?? null`,
      ) as Promise<string | null>
    const message = () =>
      page.evaluate(`document.querySelector('.message')?.textContent?.trim() ?? null`) as Promise<
        string | null
      >
    /** The button beside it, which the working tree commands without touching. */
    const untrackedButton = async () => (await topbar(page)).toggles.at(-1)

    try {
      // The fixture sits on `main`, which is its own trunk, so the bare URL
      // reviews exactly what is uncommitted — nothing else is above the base.
      writeFileSync(staged, 'export const staged = 1\n')
      git('add', 'wt-staged.ts')
      writeFileSync(untracked, 'export const untracked = 1\n')

      await load('')
      await sleep(1500)

      check(
        'the working tree is what the bare URL shows',
        (await files())?.includes('1 file') === true,
        (await files()) ?? 'nothing',
      )
      check(
        '  and the button says so',
        (await button())?.pressed === 'true',
        JSON.stringify(await button()),
      )
      check(
        '  with the untracked file counted on its own button',
        (await untrackedButton())?.label === 'Untracked (1)',
        JSON.stringify(await untrackedButton()),
      )

      await page.evaluate(`${BUTTON}.click()`)
      await sleep(1500)

      check(
        'releasing it empties the diff',
        (await files()) === null,
        (await files()) ?? 'no file list',
      )
      // "matches the base" would be a lie: the work is there, uncommitted.
      check(
        '  saying nothing is committed rather than nothing changed',
        (await message())?.includes('nothing is committed above') === true,
        (await message()) ?? 'no message',
      )
      // The untracked files leave with the working tree, whatever their own
      // button says — so it must stop counting them and stop inviting a click.
      check(
        '  taking the untracked files with it',
        (await untrackedButton())?.label === 'Untracked' && (await untrackedButton())?.off === true,
        JSON.stringify(await untrackedButton()),
      )
      const notes = (await topbar(page)).notes.join(' | ')
      check(
        '  and the topbar says the working tree is excluded',
        notes.includes('working tree excluded'),
        notes,
      )
      check(
        '  which the URL carries',
        (await topbar(page)).search.includes('committed=1'),
        (await topbar(page)).search,
      )

      await page.evaluate(`${BUTTON}.click()`)
      await sleep(1500)
      check(
        'pressing it again brings the work back',
        (await files())?.includes('1 file') === true,
        (await files()) ?? 'nothing',
      )

      // Reviewing a ref: the working tree is out whatever the button says, so it
      // must neither claim otherwise nor invite a click.
      await load('?target=feature')
      await sleep(1500)
      const onRef = await button()
      check('reviewing a ref disables the button', onRef?.off === true, JSON.stringify(onRef))
      check('  and shows it unpressed', onRef?.pressed === 'false', JSON.stringify(onRef))
    } finally {
      git('reset', '-q', '--', 'wt-staged.ts')
      rmSync(staged, { force: true })
      rmSync(untracked, { force: true })
    }
  },
} satisfies Suite
