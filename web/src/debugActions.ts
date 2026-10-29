import { debugLog } from './debugLog.ts'

const ACTIONS = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'change',
  'compositionstart',
  'compositionend',
  'focusin',
  'focusout',
  'wheel',
  'scroll',
  'touchstart',
  'touchend',
  'touchcancel',
  'copy',
  'cut',
  'paste',
  'dragstart',
  'drop',
  'submit',
  'selectionchange',
] as const

/** Observe actions in capture phase, including inside the diff's shadow roots.
 * Values, clipboard contents and printable typing in editable fields are excluded.
 */
export function startDebugActions(windowName: 'review' | 'settings'): () => void {
  const action = (event: Event) => {
    if (!debugLog.enabled) return
    const path = event.composedPath()
    const element = path.find((node): node is Element => node instanceof Element)
    const control = path.find(
      (node): node is Element =>
        node instanceof Element &&
        node.matches('button, summary, input, textarea, select, [role="button"]'),
    )
    const target = control ?? element
    const label =
      control?.getAttribute('aria-label') ??
      control?.getAttribute('title') ??
      (control?.matches('button, summary') &&
      !control.matches('.symbol-reference') &&
      !control.querySelector('.comment-preview, code, pre, [data-char]')
        ? control.textContent?.trim()
        : undefined)
    const details: Record<string, string | number | boolean | null | undefined> = {
      window: windowName,
      tag: target?.tagName,
      id: target?.id || undefined,
      class: target?.getAttribute('class') ?? undefined,
      role: target?.getAttribute('role') ?? undefined,
      label: label ?? undefined,
      trusted: event.isTrusted,
    }
    if (event instanceof MouseEvent) {
      Object.assign(details, {
        x: event.clientX,
        y: event.clientY,
        button: event.button,
        buttons: event.buttons,
        mouseButton: ['primary', 'middle', 'secondary', 'back', 'forward'][event.button],
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      })
    }
    if (event instanceof PointerEvent) details.pointerType = event.pointerType
    if (event instanceof KeyboardEvent) {
      const editable = path.some(
        (node) =>
          node instanceof HTMLElement &&
          (node.isContentEditable || node.matches('input, textarea')),
      )
      const printable =
        event.key.length === 1 || ['Dead', 'Process', 'Unidentified'].includes(event.key)
      const redact =
        event.isComposing ||
        (editable && printable && !(event.metaKey || (event.ctrlKey && !event.altKey)))
      Object.assign(details, {
        key: redact ? '[text]' : event.key,
        code: redact ? '[text]' : event.code,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        repeat: event.repeat,
      })
    }
    if (event instanceof InputEvent)
      Object.assign(details, { inputType: event.inputType, composing: event.isComposing })
    if (event instanceof WheelEvent)
      Object.assign(details, {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      })
    if (event instanceof FocusEvent)
      details.nextTag = event.relatedTarget instanceof Element ? event.relatedTarget.tagName : null
    if (event.type === 'scroll' && target instanceof HTMLElement)
      Object.assign(details, { scrollTop: target.scrollTop, scrollLeft: target.scrollLeft })
    if (
      event.type === 'change' &&
      target instanceof HTMLInputElement &&
      ['checkbox', 'radio'].includes(target.type)
    )
      details.checked = target.checked
    if (event.type === 'change' && target instanceof HTMLSelectElement)
      details.selectedIndex = target.selectedIndex
    debugLog.record(`action.${event.type}`, details)
  }
  const navigation = (event: Event) =>
    debugLog.record(`window.${event.type}`, {
      window: windowName,
      route: location.pathname + location.search,
    })
  for (const name of ACTIONS)
    document.addEventListener(name, action, { capture: true, passive: true })
  for (const name of ['popstate', 'hashchange', 'pageshow', 'focus', 'blur', 'resize'])
    window.addEventListener(name, navigation, { passive: true })
  return () => {
    for (const name of ACTIONS) document.removeEventListener(name, action, true)
    for (const name of ['popstate', 'hashchange', 'pageshow', 'focus', 'blur', 'resize'])
      window.removeEventListener(name, navigation)
  }
}
