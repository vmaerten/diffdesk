import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DiffPayload } from '../src/types.ts'
import { clickTreeRow, until, withHarness, type Check } from './harness.ts'
import { isolatedGit, serveGo } from './goBinary.ts'

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: isolatedGit }).trim()
const svg = (color: string, width = 80) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="60"><rect width="100%" height="100%" fill="${color}"/></svg>`
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  'base64',
)

export async function runImages(check: Check): Promise<void> {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'diffdesk-images-')))
  let running: Awaited<ReturnType<typeof serveGo>> | undefined
  try {
    git(path, ['init', '-q', '--initial-branch=main'])
    git(path, ['config', 'user.name', 'Image tests'])
    git(path, ['config', 'user.email', 'images@example.invalid'])
    git(path, ['config', 'commit.gpgsign', 'false'])
    git(path, ['config', 'core.hooksPath', '/dev/null'])
    writeFileSync(join(path, 'changed.svg'), svg('red'))
    const binaryBefore = Buffer.concat([png, Buffer.alloc(300)])
    const binaryAfter = Buffer.concat([png, Buffer.alloc(400)])
    writeFileSync(join(path, 'modified.PNG'), binaryBefore)
    writeFileSync(join(path, 'deleted.gif'), gif)
    writeFileSync(join(path, 'opaque.bin'), '\0before')
    writeFileSync(join(path, 'old name ~*.png'), Buffer.concat([png, Buffer.alloc(200)]))
    git(path, ['add', '-A'])
    git(path, ['commit', '-qm', 'base images'])
    const root = git(path, ['rev-parse', 'HEAD'])
    git(path, ['checkout', '-qb', 'feature'])
    writeFileSync(join(path, 'changed.svg'), svg('blue', 120))
    writeFileSync(join(path, 'modified.PNG'), binaryAfter)
    writeFileSync(join(path, 'added.png'), png)
    writeFileSync(join(path, 'opaque.bin'), '\0after')
    git(path, ['mv', 'old name ~*.png', 'renamed ~*[1].png'])
    git(path, ['rm', '-q', 'deleted.gif'])
    git(path, ['add', '-A'])
    git(path, ['commit', '-qm', 'change images'])
    const commit = git(path, ['rev-parse', 'HEAD'])
    // Move main independently: the old image must come from the merge base.
    git(path, ['checkout', '-q', 'main'])
    writeFileSync(join(path, 'changed.svg'), svg('purple'))
    git(path, ['commit', '-qam', 'trunk image'])
    git(path, ['checkout', '-q', 'feature'])
    writeFileSync(join(path, 'changed.svg'), svg('green', 160))
    git(path, ['add', 'changed.svg'])
    writeFileSync(join(path, 'changed.svg'), svg('yellow', 200))
    writeFileSync(join(path, 'untracked.png'), png)

    running = await serveGo(path, ['--base', 'main'])
    const { origin, repoId } = running
    const base = `${origin}/r/${repoId}`
    const diff = async (query: string): Promise<DiffPayload> => {
      const response = await fetch(`${base}/api/diff?base=main&${query}`)
      if (!response.ok) throw new Error(await response.text())
      const payload: DiffPayload = await response.json()
      check(
        `image URL revisions match the returned comparison (${query || 'worktree'})`,
        payload.files.every(
          ({ image }) =>
            !image ||
            (['before', 'after'] as const).every((side) => {
              const url = image[side]?.url
              return (
                !url ||
                new URL(url, origin).searchParams.get('revision') ===
                  (payload.comparison[side] ?? 'worktree')
              )
            }),
        ),
      )
      return payload
    }
    const bytes = async (url: string | null | undefined) => {
      if (!url) return Buffer.alloc(0)
      const response = await fetch(`${origin}${url}`)
      return Buffer.from(await response.arrayBuffer())
    }
    const feature = await diff('target=feature')
    const changed = feature.files.find((f) => f.path === 'changed.svg')!
    check(
      'modified images expose both versions',
      Boolean(changed.image?.before?.url && changed.image?.after?.url),
      JSON.stringify(changed.image),
    )
    check(
      'before uses the merge base, not the current trunk',
      (await bytes(changed.image?.before?.url)).toString() === svg('red'),
    )
    check(
      'a target uses committed bytes, excluding dirty work',
      (await bytes(changed.image?.after?.url)).toString() === svg('blue', 120),
    )
    const added = feature.files.find((f) => f.path === 'added.png')!
    const binary = feature.files.find((f) => f.path === 'modified.PNG')!
    const opaque = feature.files.find((f) => f.path === 'opaque.bin')!
    check(
      'non-image binaries retain their status and statistics without a preview',
      opaque.binary && !opaque.image && feature.totals.files === feature.files.length,
    )
    check(
      'modified binary images expose the exact bytes on both sides',
      (await bytes(binary.image?.before?.url)).equals(binaryBefore) &&
        (await bytes(binary.image?.after?.url)).equals(binaryAfter),
    )
    check(
      'added images have only an after version',
      added.image?.before === null && Boolean(added.image.after?.url),
    )
    check(
      'binary bytes survive the image endpoint',
      (await bytes(added.image?.after?.url)).equals(png),
    )
    const deleted = feature.files.find((f) => f.path === 'deleted.gif')!
    check(
      'deleted images have only a before version',
      deleted.image?.after === null && (await bytes(deleted.image.before?.url)).equals(gif),
    )
    const renamed = feature.files.find((f) => f.path === 'renamed ~*[1].png')!
    check(
      'renames read the old path and preserve special characters',
      (await bytes(renamed.image?.before?.url)).equals(Buffer.concat([png, Buffer.alloc(200)])) &&
        (await bytes(renamed.image?.after?.url)).equals(Buffer.concat([png, Buffer.alloc(200)])),
    )

    const working = await diff('')
    const workingImage = working.files.find((f) => f.path === 'changed.svg')!
    check(
      'working tree includes unstaged changes over the index',
      (await bytes(workingImage.image?.after?.url)).toString() === svg('yellow', 200),
    )
    check(
      'untracked images stay out until requested',
      !working.files.some((f) => f.path === 'untracked.png'),
    )
    const untracked = (await diff('untracked=1')).files.find((f) => f.path === 'untracked.png')!
    check(
      'opted-in untracked images can be previewed',
      untracked.image?.before === null && (await bytes(untracked.image.after?.url)).equals(png),
    )
    const committed = (await diff('committed=1')).files.find((f) => f.path === 'changed.svg')!
    check(
      'committed mode excludes staged and unstaged images',
      (await bytes(committed.image?.after?.url)).toString() === svg('blue', 120),
    )
    const one = (await diff(`commit=${commit}`)).files.find((f) => f.path === 'changed.svg')!
    check(
      'single-commit images use that commit and its parent',
      (await bytes(one.image?.before?.url)).toString() === svg('red') &&
        (await bytes(one.image?.after?.url)).toString() === svg('blue', 120),
    )
    const first = (await diff(`commit=${root}`)).files.find((f) => f.path === 'changed.svg')!
    check(
      'root commit images have no before version',
      first.image?.before === null &&
        (await bytes(first.image.after?.url)).toString() === svg('red'),
    )

    await fetch(`${base}/api/viewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        range: working.range,
        path: workingImage.path,
        hash: workingImage.hash,
        viewed: true,
      }),
    })
    writeFileSync(join(path, 'changed.svg'), svg('orange', 240))
    const refreshed = await diff('')
    check(
      'changing image bytes invalidates a viewed tick and the image URL',
      !('changed.svg' in refreshed.viewed) &&
        refreshed.files.find((f) => f.path === 'changed.svg')?.image?.after?.url !==
          workingImage.image?.after?.url,
    )

    symlinkSync('/etc/passwd', join(path, 'link.svg'))
    const getImage = (revision: string, name: string) =>
      fetch(`${base}/api/image?${new URLSearchParams({ revision, path: name })}`)
    check(
      'working-tree symlinks cannot expose outside files',
      (await getImage('worktree', 'link.svg')).status === 404,
    )
    check(
      'symlink previews preserve the image-specific explanation',
      (await diff('untracked=1')).files.find((file) => file.path === 'link.svg')?.image?.after
        ?.error === 'Symlink images are not previewed',
    )
    mkdirSync(join(path, 'directory'))
    writeFileSync(join(path, 'directory', 'nested.svg'), svg('red'))
    check(
      'canonical nested image paths remain readable',
      (await getImage('worktree', 'directory/nested.svg')).status === 200,
    )
    for (const name of ['changed.svg/', './changed.svg', 'directory//nested.svg']) {
      check(
        `malformed image paths are rejected: ${name}`,
        (await getImage('worktree', name)).status === 404,
      )
    }
    rmSync(join(path, 'directory'), { recursive: true })
    check(
      'path traversal is rejected',
      (await getImage('worktree', '../outside.svg')).status === 404,
    )
    check(
      'git internals cannot be requested',
      (await getImage('worktree', '.git/config.svg')).status === 404,
    )
    check(
      'arbitrary revision expressions are rejected',
      (await getImage('HEAD', 'changed.svg')).status === 404,
    )
    const svgResponse = await getImage(commit, 'changed.svg')
    check(
      'SVG responses are sandboxed images',
      svgResponse.headers.get('content-type') === 'image/svg+xml' &&
        Boolean(svgResponse.headers.get('content-security-policy')?.includes('sandbox')),
    )

    writeFileSync(join(path, 'oversized.png'), Buffer.alloc(20 * 1024 * 1024 + 1))
    const oversized = (await diff('untracked=1')).files.find((f) => f.path === 'oversized.png')!
    check(
      'oversized images report a preview limit without breaking the diff',
      oversized.image?.after?.url === null &&
        Boolean(oversized.image.after.error?.includes('20 MB')),
    )
    check(
      'oversized image requests are bounded too',
      (await getImage('worktree', 'oversized.png')).status === 404,
    )
    rmSync(join(path, 'oversized.png'))
    writeFileSync(join(path, 'broken.png'), 'not an image')

    await withHarness(path, async (make) => {
      const harness = await make()
      const { page, load } = harness
      await load('?base=main&target=feature')
      await clickTreeRow(page, 'changed.svg')
      await page.waitForSelector('[data-image-path="changed.svg"] img')
      await page.waitForFunction(() =>
        [
          ...document.querySelectorAll<HTMLImageElement>('[data-image-path="changed.svg"] img'),
        ].every((img) => img.complete && img.naturalWidth > 0),
      )
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('[data-image-path="changed.svg"] img')].map(
          (img) => ({
            width: img.naturalWidth,
            x: img.getBoundingClientRect().x,
            y: img.getBoundingClientRect().y,
          }),
        ),
      )
      check(
        'modified images render before and after side by side',
        sizes.length === 2 &&
          sizes[0]?.width === 80 &&
          sizes[1]?.width === 120 &&
          sizes[0].x < sizes[1].x &&
          sizes[0].y === sizes[1].y,
        JSON.stringify(sizes),
      )
      const zoomTrigger =
        '[data-image-path="changed.svg"] .image-side:last-child .image-zoom-trigger'
      // Selecting the file left the pane settling: click once a point of the
      // trigger actually hits it.
      const clickTrigger = async () => {
        const at = await page.waitForFunction(
          (selector) => {
            const trigger = document.querySelector(selector)
            const box = trigger?.getBoundingClientRect()
            if (!trigger || !box) return null
            const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
            return trigger.contains(document.elementFromPoint(point.x, point.y)) ? point : null
          },
          { timeout: 10_000 },
          zoomTrigger,
        )
        const { x, y } = (await at.jsonValue()) as { x: number; y: number }
        await page.mouse.click(x, y)
      }
      const previewSrc = await page.$eval(`${zoomTrigger} img`, (img) => img.getAttribute('src'))
      await clickTrigger()
      await page.waitForSelector('.image-zoom[open]')
      check(
        'clicking an image opens the selected version in a modal',
        (await page.$eval('.image-zoom-content', (img) => img.getAttribute('src'))) === previewSrc,
      )
      await page.keyboard.press('v')
      check(
        'review shortcuts do not run behind the modal',
        (await page.$('.image-zoom[open]')) !== null,
      )
      await page.keyboard.press('Escape')
      await page.waitForSelector('.image-zoom', { hidden: true })
      check(
        'Escape closes the modal and returns focus to its trigger',
        await page.$eval(zoomTrigger, (button) => document.activeElement === button),
      )
      await page.keyboard.press('Enter')
      await page.waitForSelector('.image-zoom[open]')
      await page.click('.image-zoom-heading button')
      await page.waitForSelector('.image-zoom', { hidden: true })
      check('keyboard activation and the close button work', (await page.$('.image-zoom')) === null)
      await clickTrigger()
      await page.waitForSelector('.image-zoom[open]')
      await page.mouse.click(5, 5)
      await page.waitForSelector('.image-zoom', { hidden: true })
      check('clicking the backdrop closes the modal', (await page.$('.image-zoom')) === null)
      await page.keyboard.press('v')
      check(
        'viewed images fold away',
        await until(page, `!document.querySelector('[data-image-path="changed.svg"]')`, 5_000),
      )
      await page.keyboard.press('v')
      await page.waitForSelector('[data-image-path="changed.svg"] img')
      await clickTreeRow(page, 'added.png')
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLImageElement>('[data-image-path="added.png"] img')
            ?.naturalWidth === 1,
      )
      check(
        'an added binary image renders once',
        (await page.$$eval('[data-image-path="added.png"] img', (imgs) => imgs.length)) === 1,
      )
      for (const [query, width] of [
        ['?base=main', 240],
        ['?base=main&committed=1', 120],
        [`?base=main&commit=${commit}`, 120],
      ] as const) {
        await load(query)
        await clickTreeRow(page, 'changed.svg')
        await page.waitForFunction(
          (expectedWidth) =>
            document.querySelector<HTMLImageElement>(
              '[data-image-path="changed.svg"] .image-side:last-child img',
            )?.naturalWidth === expectedWidth,
          {},
          width,
        )
        check(`browser image matches the comparison (${query})`, true)
      }
      await load('?base=main&untracked=1')
      await clickTreeRow(page, 'untracked.png')
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLImageElement>('[data-image-path="untracked.png"] img')
            ?.naturalWidth === 1,
      )
      check('an opted-in untracked image renders in the browser', true)
      await clickTreeRow(page, 'link.svg')
      await page.waitForSelector('[data-image-path="link.svg"] .image-error')
      check(
        'unsafe image sources show their explanation in the browser',
        (await page.$eval('[data-image-path="link.svg"] .image-error', (el) => el.textContent)) ===
          'Symlink images are not previewed',
      )
      await clickTreeRow(page, 'broken.png')
      await page.waitForSelector('[data-image-path="broken.png"] .image-error')
      check(
        'undecodable images show a readable fallback',
        (await page.$eval('[data-image-path="broken.png"] .image-error', (el) =>
          el.textContent?.includes('could not be displayed'),
        )) === true,
      )
      check('no browser errors', harness.errors.length === 0, harness.errors.join(' | '))
    })
  } finally {
    await running?.close()
    rmSync(path, { recursive: true, force: true })
  }
}
