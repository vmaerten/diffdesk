import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DiffPayload } from '../../src/types.ts'
import { allTreeRows, openPicker, topbar, type Suite } from '../harness.ts'

const git = (path: string, ...args: string[]) =>
  execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' })

export default {
  name: 'worktree-selection',
  async run({ page, load, repoPath, url }, check) {
    const directory = mkdtempSync(join(tmpdir(), 'ghl-picker-'))
    const linked = join(directory, 'worktree é with spaces')
    const originalPath = new URL(url()).pathname
    const choose = async (branch: string, path: string) => {
      await openPicker(page, 't')
      await page.keyboard.type(branch)
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        (expectedPath, expectedBranch) =>
          location.pathname === expectedPath &&
          document.querySelector('.ref.target')?.textContent?.includes(expectedBranch),
        {},
        path,
        branch,
      )
      await page.waitForSelector('file-tree-container')
    }
    try {
      git(repoPath, 'worktree', 'add', '-q', '-b', 'linked/picker', linked, 'feature')
      writeFileSync(join(linked, 'worktree-local.ts'), 'export const value = "committed"\n')
      git(linked, 'add', 'worktree-local.ts')
      git(linked, 'commit', '-qm', 'linked picker change')
      writeFileSync(
        join(linked, 'worktree-local.ts'),
        'export const value = "local worktree edit"\n',
      )
      writeFileSync(join(linked, 'worktree-staged.ts'), 'export const staged = true\n')
      git(linked, 'add', 'worktree-staged.ts')
      writeFileSync(join(linked, 'worktree-untracked.ts'), 'export const untracked = true\n')
      writeFileSync(join(repoPath, 'picker-original.ts'), 'export const original = true\n')
      git(repoPath, 'add', 'picker-original.ts')

      await load('?target=feature&base=release&committed&untracked&w=1')
      await openPicker(page, 't')
      await page.keyboard.type('linked/picker')
      await page.keyboard.press('Enter')
      await page.waitForFunction(
        (previousPath) =>
          location.pathname !== previousPath &&
          document.querySelector('.ref.target')?.textContent?.includes('linked/picker'),
        {},
        originalPath,
      )
      await page.waitForSelector('file-tree-container')
      const linkedPath = new URL(page.url()).pathname
      const selected = await topbar(page)
      check(
        'selecting a linked branch opens its worktree automatically',
        linkedPath !== originalPath,
      )
      check(
        'the working tree is included and can be toggled',
        selected.toggles[0]?.pressed === true && selected.toggles[0]?.off === false,
      )
      const params = new URL(page.url()).searchParams
      check(
        'worktree navigation resets the old base and revision scope',
        !['base', 'target', 'commit', 'committed'].some((key) => params.has(key)),
      )
      check(
        'worktree navigation keeps whitespace and untracked options',
        params.get('w') === '1' && params.has('untracked'),
      )
      const diff = (await page.evaluate(async () => {
        const response = await fetch(location.pathname + '/api/diff' + location.search)
        return response.json()
      })) as DiffPayload
      check(
        'the diff includes local and staged edits from the selected worktree',
        diff.patch.includes('local worktree edit') && diff.patch.includes('worktree-staged.ts'),
      )
      check(
        'untracked files come from the selected worktree',
        diff.files.some((file) => file.path === 'worktree-untracked.ts'),
      )
      check(
        'the previous checkout changes do not leak into the diff',
        !diff.files.some((file) => file.path === 'picker-original.ts'),
      )
      const rows = await allTreeRows(page)
      check(
        'the tree renders the selected worktree files',
        rows.some((row) => row.path === 'worktree-local.ts'),
      )

      await page.goBack()
      await page.waitForFunction(
        (path) =>
          location.pathname === path &&
          document.querySelector('.ref.target')?.textContent?.includes('feature'),
        {},
        originalPath,
      )
      check(
        'browser Back restores the original comparison',
        (await topbar(page)).search.includes('target=feature'),
      )
      await choose('linked/picker', linkedPath)
      await page.reload({ waitUntil: 'networkidle0' })
      await page.waitForSelector('file-tree-container')
      check(
        'reloading keeps the registered worktree and local scope',
        (await topbar(page)).toggles[0]?.pressed === true,
      )
      await choose('main', originalPath)
      const returned = await topbar(page)
      check(
        'selecting the original branch returns to its worktree',
        returned.target === 'main' && returned.toggles[0]?.pressed === true,
      )
      check(
        'the original checkout local changes reappear',
        (await allTreeRows(page)).some((row) => row.path === 'picker-original.ts'),
      )
    } finally {
      git(repoPath, 'reset', '-q', '--', 'picker-original.ts')
      rmSync(join(repoPath, 'picker-original.ts'), { force: true })
      git(repoPath, 'worktree', 'remove', '--force', linked)
      git(repoPath, 'branch', '-D', 'linked/picker')
      rmSync(directory, { recursive: true, force: true })
    }
  },
} satisfies Suite
