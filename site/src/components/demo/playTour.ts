// The demo playing itself: a cursor that drives the real demo with DOM events,
// until the visitor takes over. Those events are untrusted, which tells them apart.

export const STEPS = [
  'Hold ⌘ over a name for its type',
  '⌘-click goes to its definition',
  'c comments the selected line',
  '⌘K runs any command',
  'Click 2/3 to review another layer',
] as const

export interface Cursor {
  /** In the viewport, as getBoundingClientRect measures. */
  x: number
  y: number
  pressed: boolean
  /** The keys held, shown beside the pointer. */
  keys?: string
}

export interface TourStage {
  frame: HTMLElement
  cursor: (cursor: Cursor | null) => void
  step: (index: number) => void
}

type Point = { x: number; y: number }

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })

const center = (element: Element | Range): Point => {
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** The first letter of word on a line of the file's new side, and the token holding it. */
function wordAt(frame: HTMLElement, path: string, line: number, word: string) {
  const root = frame.querySelector(`.demo-file[data-path="${path}"] diffs-container`)?.shadowRoot
  const row = [...(root?.querySelectorAll<HTMLElement>(`[data-line="${line}"]`) ?? [])].find(
    (each) => each.dataset.lineType !== 'change-deletion',
  )
  if (!row) throw new Error(`The tour cannot find ${path}:${line}`)
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.search(new RegExp(`\\b${word}\\b`))
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + 1)
    return { token: node.parentElement!, ...center(range) }
  }
  throw new Error(`The tour cannot find ${word} on ${path}:${line}`)
}

const key = (target: EventTarget, type: 'keydown' | 'keyup', name: string, meta = false) =>
  target.dispatchEvent(
    new KeyboardEvent(type, { key: name, metaKey: meta, bubbles: true, cancelable: true }),
  )

/** Types into a field React controls, through the setter React watches. */
async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  wait: (ms: number) => Promise<void>,
) {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  for (let length = 1; length <= text.length; length++) {
    setValue.call(field, text.slice(0, length))
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(38)
  }
}

/** Plays the tour from the demo's first state; rejects once aborted, with the event that took over as the reason. */
export async function playTour({ frame, cursor, step }: TourStage, signal: AbortSignal) {
  const wait = (ms: number) => pause(ms, signal)
  let at: Point = center(frame)
  const point = async (to: Point, keys?: string) => {
    at = to
    cursor({ ...to, pressed: false, keys })
    await wait(750)
  }
  const press = async (keys?: string) => {
    cursor({ ...at, pressed: true, keys })
    await wait(160)
    cursor({ ...at, pressed: false, keys })
  }
  const click = async (element: Element) => {
    await point(center(element))
    await press()
    ;(element as HTMLElement).click()
  }
  // The diff hears the pointer on its <pre>: leaving it lets go of the token, and closes the card.
  let diff: Element | null = null
  let metaHeld = false
  const leave = () =>
    diff?.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
  const find = <T extends Element>(selector: string, scope: ParentNode = frame) => {
    const found = scope.querySelector<T>(selector)
    if (!found) throw new Error(`The tour cannot find ${selector}`)
    return found
  }

  try {
    // Lets the demo settle back into its first state.
    await wait(500)
    step(0)
    // Measured again before each use: the visitor may scroll the page meanwhile.
    const live = () => wordAt(frame, 'web/src/stack.ts', 10, 'live')
    await point(live())
    const hovered = live()
    diff = hovered.token.closest('pre')
    hovered.token.dispatchEvent(
      new PointerEvent('pointermove', {
        pointerType: 'mouse',
        clientX: hovered.x,
        clientY: hovered.y,
        bubbles: true,
        composed: true,
      }),
    )
    cursor({ ...hovered, pressed: false, keys: '⌘' })
    key(window, 'keydown', 'Meta', true)
    metaHeld = true
    await wait(2400)

    step(1)
    await press('⌘')
    const clicked = live()
    clicked.token.dispatchEvent(
      new MouseEvent('click', {
        metaKey: true,
        clientX: clicked.x,
        clientY: clicked.y,
        bubbles: true,
        composed: true,
      }),
    )
    await wait(300)
    key(window, 'keyup', 'Meta')
    metaHeld = false
    leave()
    cursor({ ...at, pressed: false })
    await wait(1600)

    step(2)
    cursor({ ...at, pressed: false, keys: 'c' })
    key(frame, 'keydown', 'c')
    await wait(600)
    cursor({ ...at, pressed: false })
    await type(find('.composer textarea'), 'Extract this filter: layerBelow repeats it.', wait)
    await wait(400)
    await click(find('.composer button[type="submit"]'))
    await wait(1800)

    step(3)
    cursor({ ...at, pressed: false, keys: '⌘K' })
    key(frame, 'keydown', 'k', true)
    await wait(700)
    const search = find<HTMLInputElement>('.command-palette .palette-input', document)
    await type(search, 'split', wait)
    await wait(600)
    key(search, 'keydown', 'Enter')
    cursor({ ...at, pressed: false })
    await wait(1800)
    await click(find('.segmented button'))
    await wait(900)

    step(4)
    await click(find('.capsule .layer'))
    await wait(800)
    const picker = [...frame.querySelectorAll('.stack-picker button.stack-branch')].find(
      (button) => button.textContent === 'stack-picker',
    )
    if (picker) await click(picker)
    await wait(1400)
  } finally {
    // A visitor who takes over with ⌘ down holds it, and points at what they want themselves.
    if (!(signal.reason instanceof KeyboardEvent && signal.reason.metaKey)) {
      if (metaHeld) key(window, 'keyup', 'Meta')
      leave()
    }
    cursor(null)
  }
}
