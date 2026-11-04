import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { KeyInput } from 'puppeteer-core'

import type { DiffPayload } from '../../src/types.ts'
import { poll, type Suite } from '../harness.ts'

const PANEL = '.walkthrough-panel:not([hidden])'

/** Stored as `diffdesk walkthrough set` writes it; without fingerprints, hunks are found by rank. */
const tour = {
  version: 1,
  branch: '',
  range: '',
  workingTree: false,
  author: 'agent',
  createdAt: '2026-10-29T12:00:00Z',
  fingerprints: {},
  walkthrough: {
    version: 1,
    title: 'Grow the core',
    focus: 'The engine gains ten lines; `cache.ts` is new.',
    chapters: [
      {
        title: 'Core',
        stops: [
          { title: 'Engine grows', summary: 'Ten more lines.', hunks: ['src/core/engine.ts#1'] },
          {
            title: 'A cache',
            summary: 'New file, and the parser shrinks.',
            prose: 'Read `cache.ts` first.',
            hunks: ['src/core/cache.ts#1', 'src/core/parser.ts#1'],
          },
        ],
      },
    ],
  },
}

export default {
  name: 'walkthrough',
  async run({ page, load, url, repoPath }, check) {
    const endpoint = new URL(url())
    const payload = async () =>
      (await (
        await fetch(`${endpoint.origin}${endpoint.pathname}/api/diff${new URL(page.url()).search}`)
      ).json()) as DiffPayload
    const press = async (key: KeyInput) => {
      await page.focus('.diff')
      await page.keyboard.press(key)
    }
    const current = () =>
      page.$eval(`${PANEL} [aria-current="step"] .walkthrough-stop-title`, (title) =>
        title.textContent?.trim(),
      )
    const markers = () =>
      page.$$eval('.walkthrough-marker', (cards) => cards.map((card) => card.textContent))

    await load()
    const { commentBranch } = await payload()
    const file = join(
      repoPath,
      '.git',
      'ghl',
      'walkthroughs',
      `${encodeURIComponent(commentBranch)}.json`,
    )

    await press('n')
    await page.waitForSelector(PANEL)
    check(
      'n without a walkthrough opens the panel on how to write one',
      (await page.$eval(PANEL, (panel) => panel.textContent)).includes(
        'diffdesk walkthrough guide',
      ),
    )

    mkdirSync(join(repoPath, '.git', 'ghl', 'walkthroughs'), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...tour, branch: commentBranch }))
    await press('r')
    await page.waitForSelector(`${PANEL} .walkthrough-head`)
    check('a refresh shows the saved walkthrough', (await current()) === 'Engine grows')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.walkthrough-marker')].some((card) =>
          card.textContent?.includes('Stop 1 of 2'),
        ),
      { timeout: 5_000 },
    )
    check(
      'the stop marks its hunk in the diff',
      (await markers()).join() === 'Stop 1 of 2Engine grows',
    )

    await press('n')
    await page.waitForFunction(
      (panel) =>
        document.querySelector(`${panel} [aria-current="step"]`)?.textContent?.includes('A cache'),
      { timeout: 5_000 },
      PANEL,
    )
    check(
      'n moves to the next stop and opens its prose',
      (await page.$eval(`${PANEL} .walkthrough-prose`, (prose) => prose.innerHTML)) ===
        'Read <code>cache.ts</code> first.',
    )
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.walkthrough-marker')].some((card) =>
          card.textContent?.includes('Stop 2 of 2'),
        ),
      { timeout: 5_000 },
    )
    check(
      'its hunks are marked in place of the first stop’s',
      !(await markers()).some((text) => text?.includes('Stop 1')),
    )
    const stored = await poll(
      async () => JSON.parse(readFileSync(file, 'utf8')) as { read?: number[] },
      (saved) => saved.read?.length === 1,
    )
    check('leaving a stop records it read', JSON.stringify(stored.read) === '[0]')

    await press('p')
    check(
      'p goes back',
      (await poll(current, (title) => title === 'Engine grows')) === 'Engine grows',
    )

    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })
    await press('n')
    await page.waitForSelector(`${PANEL} .walkthrough-head`)
    check(
      'progress survives a reload',
      (await page.$eval(`${PANEL} .walkthrough-progress`, (progress) => progress.textContent)) ===
        '1/2 read',
    )

    rmSync(file)
  },
} satisfies Suite
