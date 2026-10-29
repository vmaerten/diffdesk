import type { DiffPayload } from '../../src/types.ts'
import { COMMENTS_OPEN, poll, type Suite } from '../harness.ts'

const COMPOSER = `${COMMENTS_OPEN} .panel-editor textarea`

export default {
  name: 'scoped-comments',
  async run({ page, load, url }, check) {
    const endpoint = new URL(url())
    const api = (route: string) => `${endpoint.origin}${endpoint.pathname}/api/${route}`
    const stored = async () =>
      // The page's own comparison: comments belong to the branch it reviews.
      (
        (await (await fetch(api(`diff${new URL(page.url()).search}`))).json()) as DiffPayload
      ).comments.filter((comment) => comment.start === 0 && comment.end === 0)
    const submit = async (text: string) => {
      await page.waitForSelector(COMPOSER)
      await page.type(COMPOSER, text)
      await page.keyboard.down('Meta')
      await page.keyboard.press('Enter')
      await page.keyboard.up('Meta')
      await page.waitForSelector(COMPOSER, { hidden: true })
    }
    const saved = async (body: string) =>
      (await poll(stored, (comments) => comments.some((comment) => comment.body === body))).find(
        (comment) => comment.body === body,
      )
    const groups = () =>
      page.$$eval(`${COMMENTS_OPEN} .comment-file`, (sections) =>
        sections.map((section) => section.getAttribute('aria-label')),
      )

    try {
      await load()
      const path = await page.$eval(
        '[data-header-path]',
        (header) => (header as HTMLElement).dataset.headerPath!,
      )

      await page.click(`[data-header-path="${path}"] button[aria-label="Comment on ${path}"]`)
      await page.waitForSelector(COMPOSER)
      check(
        "a file's header opens a composer in its group of the panel",
        (await groups()).includes(path),
      )
      await page.type(COMPOSER, 'abandoned')
      await page.keyboard.press('Escape')
      await page.waitForSelector(COMPOSER, { hidden: true })
      check('escape abandons it', (await stored()).length === 0)

      await page.click(`[data-header-path="${path}"] button[aria-label="Comment on ${path}"]`)
      await submit('Split this file')
      await page.waitForFunction(
        (file) => document.querySelector(`[aria-label="${file}"] .comment .comment-lines`),
        {},
        path,
      )
      const file = await saved('Split this file')
      check('the comment is saved on the whole file', file?.path === path, JSON.stringify(file))
      check(
        '  shown as the file’s, with a way back to it',
        await page.$eval(
          `${COMMENTS_OPEN} [data-comment-id="${file?.id}"]`,
          (card) =>
            card.querySelector('.comment-lines')?.textContent === 'File' &&
            card.querySelector('.comment-navigation button') !== null,
        ),
      )
      check(
        '  and not under a line of the diff',
        (await page.$$(`.diff [data-comment-id="${file?.id}"]`)).length === 0,
      )

      await page.click(`${COMMENTS_OPEN} button[aria-label="Comment on the review"]`)
      await submit('Simplify the naming')
      await page.waitForFunction(() => document.querySelector('[aria-label="Review"] .comment'))
      const review = await saved('Simplify the naming')
      check(
        'the + saves a comment on the whole review',
        review?.path === '',
        JSON.stringify(review),
      )
      check('the review group comes first', (await groups())[0] === 'Review')
      check(
        '  with nothing to view in the diff',
        await page.$eval(
          `${COMMENTS_OPEN} [data-comment-id="${review?.id}"]`,
          (card) => card.querySelector('.comment-navigation') === null,
        ),
      )
    } finally {
      for (const comment of await stored())
        await fetch(api(`comments?id=${comment.id}`), { method: 'DELETE' })
    }
  },
} satisfies Suite
