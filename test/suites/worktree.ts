import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { openOptions, sleep, titlebar, type Suite } from '../harness.ts'

/** Named, since the Options popover holds other checkboxes beside it. */
const BUTTON = `document.querySelector('.options-popover .scope-check input.worktree')`

export default {
  name: 'worktree',
  async run({ page, load, repoPath }, check) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath })
    const staged = join(repoPath, 'wt-staged.ts')
    const untracked = join(repoPath, 'wt-untracked.ts')

    const button = () =>
      page.evaluate(`(() => {
        const b = ${BUTTON}
        return b ? { pressed: String(b.checked), off: b.disabled } : null
      })()`) as Promise<{ pressed: string; off: boolean } | null>
    const files = async () => (await titlebar(page)).files
    const message = () =>
      page.evaluate(`document.querySelector('.message')?.textContent?.trim() ?? null`) as Promise<
        string | null
      >
    /** The checkbox beside it, which the working tree controls without changing. */
    const untrackedButton = async () => (await titlebar(page)).toggles.at(-1)

    try {
      // The fixture sits on `main`, which is its own trunk, so the bare URL
      // reviews exactly what is uncommitted — nothing else is above the base.
      writeFileSync(staged, 'export const staged = 1\n')
      git('add', 'wt-staged.ts')
      writeFileSync(untracked, 'export const untracked = 1\n')

      await load('')
      await sleep(1500)
      await openOptions(page)

      check(
        'the working tree is what the bare URL shows',
        (await files()) === 1,
        String(await files()),
      )
      check(
        '  and the checkbox says so',
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

      check('releasing it empties the diff', (await files()) === null, String(await files()))
      // "matches the base" would be a lie: the work is there, uncommitted.
      check(
        '  saying nothing is committed rather than nothing changed',
        (await message())?.includes('nothing is committed above') === true,
        (await message()) ?? 'no message',
      )
      // The untracked files leave with the working tree, whatever their own
      // checkbox says — so it must stop counting them and stop inviting a click.
      check(
        '  taking the untracked files with it',
        (await untrackedButton())?.label === 'Untracked' && (await untrackedButton())?.off === true,
        JSON.stringify(await untrackedButton()),
      )
      const notes = (await titlebar(page)).notes.join(' | ')
      check(
        '  and the status bar says the working tree is excluded',
        notes.includes('working tree excluded'),
        notes,
      )
      check(
        '  which the URL carries',
        (await titlebar(page)).search.includes('committed=1'),
        (await titlebar(page)).search,
      )

      await page.evaluate(`${BUTTON}.click()`)
      await sleep(1500)
      check('pressing it again brings the work back', (await files()) === 1, String(await files()))

      // Reviewing a ref: the working tree is out whatever the checkbox says, so it
      // must neither claim otherwise nor invite a click.
      await load('?target=feature')
      await sleep(1500)
      await openOptions(page)
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
