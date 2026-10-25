import { allTreeRows, poll, until, type Suite } from '../harness.ts'

const MENUS = `window.desktopFixture.fileMenus`
const TREE = `document.querySelector('file-tree-container').shadowRoot`
const FILES = `[...document.querySelectorAll('.diff diffs-container')]`

export default {
  name: 'file-menu',
  async run({ page, load }, check) {
    await load()
    await page.waitForSelector('.viewed-toggle input', { timeout: 30_000 })

    /** Right-click what `find` returns; true when the page kept its default menu. */
    const rightClick = (find: string) =>
      page.evaluate(`(() => {
        const target = ${find}
        if (!target) throw new Error('nothing to right-click')
        const box = target.getBoundingClientRect()
        return target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, composed: true, cancelable: true,
          clientX: box.left + 4, clientY: box.top + 4,
        }))
      })()`) as Promise<boolean>
    const menus = () => page.evaluate(MENUS) as Promise<{ path: string; viewed: boolean }[]>

    const row = (await page.evaluate(
      `${TREE}.querySelector('[data-item-type="file"]').getAttribute('data-item-path')`,
    )) as string
    const kept = await rightClick(`${TREE}.querySelector('[data-item-path="${row}"]')`)
    check(
      'a file row opens the file menu',
      !kept && (await menus()).at(-1)?.path === row,
      JSON.stringify(await menus()),
    )
    check('  marked not viewed', (await menus()).at(-1)?.viewed === false)

    const titles = (await page.evaluate(
      `${FILES}.map((host) => host.shadowRoot.querySelector('[data-title]')?.textContent.trim())`,
    )) as string[]
    const last = titles.length - 1
    const clicked = titles[last]!
    await rightClick(`${FILES}[${last}].shadowRoot.querySelector('[data-diffs-header]')`)
    check(
      'a file header opens the menu for that file, not the active one',
      (await menus()).at(-1)?.path === clicked,
      `${(await menus()).at(-1)?.path} for ${clicked}`,
    )

    const before = (await menus()).length
    const code = await rightClick(`${FILES}[0].shadowRoot.querySelector('[data-line]')`)
    check('code keeps the default menu', code && (await menus()).length === before)
    const folder = (await page.evaluate(
      `${TREE}.querySelector('[data-item-type="folder"]') !== null`,
    )) as boolean
    if (folder) {
      await rightClick(`${TREE}.querySelector('[data-item-type="folder"]')`)
      check('  and so does a folder', (await menus()).length === before)
    }

    const fileCommand = (command: string, path: string) =>
      page.evaluate(
        (detail) => void window.dispatchEvent(new CustomEvent('desktop:file-command', { detail })),
        { command, path },
      )
    const ticked = async () =>
      (await allTreeRows(page)).filter((r) => r.decoration.includes('✓')).map((r) => r.path)

    await fileCommand('viewed', clicked)
    const viewed = await poll(ticked, (paths) => paths.includes(clicked), 5_000)
    check(
      'Viewed marks the clicked file only',
      viewed.length === 1 && viewed[0] === clicked,
      viewed.join(', '),
    )
    await rightClick(`${FILES}[${last}].shadowRoot.querySelector('[data-diffs-header]')`)
    check('  and the menu then shows it ticked', (await menus()).at(-1)?.viewed === true)

    await fileCommand('copy-path', clicked)
    check(
      'Copy Path copies the clicked file',
      await until(page, `window.desktopFixture.clipboard === ${JSON.stringify(clicked)}`),
    )
    await fileCommand('reveal', clicked)
    check(
      'Reveal in Finder reveals the clicked file',
      await until(page, `window.desktopFixture.revealed.at(-1) === ${JSON.stringify(clicked)}`),
    )
  },
} satisfies Suite
