import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStableCallback } from '@pierre/diffs/react'
import type { LanguageStatus, SymbolAnswer, SymbolQuery } from '../../src/types.ts'
import { IDENTIFIER, lookUpSymbol, serverFor, StaleSymbolError } from './codeIntelligence.ts'
import HighlightedCode from './HighlightedCode.tsx'
import type { SyntaxTheme } from './theme.ts'

/** What the diff's token callbacks hand over, with the item they belong to. */
interface TokenEvent {
  lineNumber: number
  lineCharStart: number
  tokenText: string
  tokenElement: HTMLElement
  side?: 'additions' | 'deletions'
}
type TokenContext = { item?: { type?: string; fileDiff?: { name: string } } } | undefined

export interface TokenHandlers {
  onTokenEnter: (token: TokenEvent, event: PointerEvent, context?: TokenContext) => void
  onTokenLeave: (token: TokenEvent, event: PointerEvent, context?: TokenContext) => void
  onTokenClick: (token: TokenEvent, event: MouseEvent, context?: TokenContext) => void
}

type Lookup =
  | { status: 'loading' }
  | { status: 'done'; answer: SymbolAnswer }
  | { status: 'error'; message: string }

interface Card {
  query: SymbolQuery
  rect: DOMRect
  lookup: Lookup
  /** Shows the definition's code: ⌘-click found it outside what the diff displays. */
  expanded: boolean
}

const OPEN_DELAY = 150
const CLOSE_DELAY = 250
/** The characters of a symbol's name, in any language ghl serves. */
const WORD = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]+/gu

/**
 * The word of a token under x, with its place on screen.
 *
 * Highlighters merge neighbouring tokens: Python's ` helper(name)`, or a Helm
 * template's `.Values.replicaCount`, are one token each. Measuring the token's
 * characters finds the name the pointer is on, and underlining that rectangle
 * rather than the token marks just the name.
 */
function wordAt(
  token: TokenEvent,
  x: number,
): { start: number; text: string; rect: DOMRect } | null {
  const range = document.createRange()
  const rects: DOMRect[] = []
  const walker = document.createTreeWalker(token.tokenElement, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      rects.push(range.getBoundingClientRect())
    }
  }
  const hit = rects.findIndex((rect) => x >= rect.left && x < rect.right)
  if (hit < 0) return null
  for (const match of token.tokenText.matchAll(WORD)) {
    const end = match.index + match[0].length
    if (hit < match.index || hit >= end) continue
    if (!IDENTIFIER.test(match[0])) return null
    const first = rects[match.index]!
    const last = rects[end - 1]!
    return {
      start: match.index,
      text: match[0],
      rect: new DOMRect(first.left, first.top, last.right - first.left, first.height),
    }
  }
  return null
}

/**
 * Hover and ⌘-click on the diff's symbols, answered by the language servers.
 *
 * Nothing happens without ⌘: reading a diff should not pop cards up. Only the
 * additions side and the context of a working-tree review are asked, because a
 * server reads the disk and those are the only lines numbered as on disk.
 */
export function useSymbolCard({
  repoId,
  enabled,
  languages,
  loadId,
  canReveal,
  reveal,
  onAnswer,
  onReferences,
  theme,
  ask = (query) => lookUpSymbol(repoId!, query),
}: {
  repoId: string | null
  enabled: boolean
  languages: readonly LanguageStatus[]
  /** A new load of the review drops what was looked up before. */
  loadId: number | undefined
  /** Whether the diff displays this line of the new side. */
  canReveal: (path: string, line: number) => boolean
  reveal: (path: string, line: number) => void
  /** A server answered, so its state may have moved on. */
  onAnswer: () => void
  /** Lists the symbol's references; undefined leaves the card without the action. */
  onReferences?: (query: SymbolQuery, answer: SymbolAnswer) => void
  /** The review's syntax theme, for the card's code. */
  theme: SyntaxTheme
  /** Answers a query, from the review server's language servers unless given. */
  ask?: (query: SymbolQuery) => Promise<SymbolAnswer>
}): { handlers: TokenHandlers; card: ReactNode } {
  const [card, setCard] = useState<Card | null>(null)
  const [underline, setUnderline] = useState<DOMRect | null>(null)
  const hovered = useRef<{ token: TokenEvent; path: string } | null>(null)
  const pointer = useRef(0)
  const commandHeld = useRef(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const answers = useRef(new Map<string, Promise<SymbolAnswer>>())
  const back = useRef<{ path: string; line: number }[]>([])
  const armed = useRef<string | null>(null)

  useEffect(() => {
    answers.current.clear()
    setCard(null)
  }, [loadId])

  /** The file of a token code intelligence answers for, or null. */
  const pathOf = useStableCallback((token: TokenEvent, context: TokenContext): string | null => {
    const path = context?.item?.type === 'diff' ? context.item.fileDiff?.name : undefined
    if (!enabled || !repoId || !path || token.side !== 'additions') return null
    return serverFor(languages, path) ? path : null
  })

  /** The symbol under the pointer in the hovered token, as the server is asked about it. */
  const symbolAt = useStableCallback((x: number): { query: SymbolQuery; rect: DOMRect } | null => {
    const token = hovered.current
    const word = token && wordAt(token.token, x)
    if (!token || !word) return null
    return {
      query: {
        path: token.path,
        line: token.token.lineNumber,
        character: token.token.lineCharStart + word.start,
        token: word.text,
      },
      rect: word.rect,
    }
  })

  const lookUp = (query: SymbolQuery): Promise<SymbolAnswer> => {
    const key = `${query.path}:${query.line}:${query.character}:${query.token}`
    let answer = answers.current.get(key)
    if (!answer) {
      answer = ask(query)
      answers.current.set(key, answer)
      // A stale file or a server that failed may answer differently next time.
      answer.then(onAnswer, () => {
        answers.current.delete(key)
        onAnswer()
      })
    }
    return answer
  }

  const show = useStableCallback(async (query: SymbolQuery, rect: DOMRect, expanded: boolean) => {
    const same = (current: Card | null) =>
      current?.query.path === query.path &&
      current.query.line === query.line &&
      current.query.character === query.character
    setCard((current) =>
      same(current) && current
        ? { ...current, expanded: current.expanded || expanded }
        : { query, rect, lookup: { status: 'loading' }, expanded },
    )
    let lookup: Lookup
    try {
      lookup = { status: 'done', answer: await lookUp(query) }
    } catch (cause) {
      lookup = {
        status: 'error',
        message:
          cause instanceof StaleSymbolError
            ? 'This file changed on disk since the review loaded. Press r to refresh.'
            : String(cause instanceof Error ? cause.message : cause),
      }
    }
    setCard((current) => (same(current) && current ? { ...current, lookup } : current))
  })

  const close = useStableCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(closeTimer.current)
    armed.current = null
    setCard(null)
  })

  const disarm = useStableCallback(() => {
    clearTimeout(openTimer.current)
    armed.current = null
    setUnderline(null)
  })

  /** Underlines the symbol under the pointer and opens its card after a pause. */
  const arm = useStableCallback(() => {
    const symbol = symbolAt(pointer.current)
    if (!symbol) return disarm()
    const key = `${symbol.query.line}:${symbol.query.character}`
    if (armed.current === key) return
    armed.current = key
    setUnderline(symbol.rect)
    clearTimeout(openTimer.current)
    openTimer.current = setTimeout(() => void show(symbol.query, symbol.rect, false), OPEN_DELAY)
  })

  const openDefinition = useStableCallback(async (query: SymbolQuery, rect: DOMRect | null) => {
    // From the card's button, the card is already there: it only needs the code.
    const expand = () =>
      rect
        ? void show(query, rect, true)
        : setCard((current) => (current ? { ...current, expanded: true } : current))
    let answer: SymbolAnswer
    try {
      answer = await lookUp(query)
    } catch {
      expand()
      return
    }
    const definition = answer.definitions.find((found) => found.inRepo) ?? answer.definitions[0]
    if (definition?.inRepo && canReveal(definition.path, definition.line)) {
      back.current.push({ path: query.path, line: query.line })
      close()
      disarm()
      reveal(definition.path, definition.line)
    } else {
      expand()
    }
  })

  // Always handed to the diff, which takes callbacks only when a file first
  // renders: ones added later would never be called. Each checks for itself
  // whether code intelligence answers.
  const handlers = useMemo<TokenHandlers>(
    () => ({
      onTokenEnter: (token, event, context) => {
        const path = pathOf(token, context)
        if (!path) return
        hovered.current = { token, path }
        pointer.current = event.clientX
        clearTimeout(closeTimer.current)
        if (event.metaKey || commandHeld.current) arm()
      },
      onTokenLeave: (token) => {
        if (hovered.current?.token.tokenElement !== token.tokenElement) return
        hovered.current = null
        disarm()
        closeTimer.current = setTimeout(() => setCard(null), CLOSE_DELAY)
      },
      onTokenClick: (token, event, context) => {
        if (!event.metaKey) return
        const path = pathOf(token, context)
        if (!path) return
        hovered.current = { token, path }
        const symbol = symbolAt(event.clientX)
        if (!symbol) return
        event.preventDefault()
        void openDefinition(symbol.query, symbol.rect)
      },
    }),
    [pathOf, symbolAt, arm, disarm, openDefinition],
  )

  useEffect(() => {
    if (!enabled) return
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') {
        commandHeld.current = true
        arm()
      } else if (event.key === 'Escape' && card) {
        close()
      } else if (event.metaKey && event.key === '[' && back.current.length > 0) {
        event.preventDefault()
        const previous = back.current.pop()!
        close()
        reveal(previous.path, previous.line)
      }
    }
    const keyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Meta') return
      commandHeld.current = false
      disarm()
    }
    const blur = () => {
      commandHeld.current = false
      disarm()
    }
    // A long token holds several names: the one under the pointer may change within it.
    const move = (event: PointerEvent) => {
      pointer.current = event.clientX
      if (commandHeld.current && hovered.current) arm()
    }
    // The card is placed against the token: once the diff moves, it points nowhere.
    const scroll = (event: Event) => {
      if (
        !(
          event.target instanceof Node &&
          document.querySelector('.symbol-card')?.contains(event.target)
        )
      ) {
        close()
        disarm()
      }
    }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    window.addEventListener('pointermove', move)
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [enabled, card, close, reveal, arm, disarm])

  useEffect(() => {
    if (!enabled) {
      close()
      disarm()
    }
  }, [enabled, close, disarm])

  const server = card ? serverFor(languages, card.query.path)?.server?.name : undefined
  return {
    handlers,
    card: (
      <>
        {underline && (
          <span
            className="symbol-underline"
            aria-hidden="true"
            style={{
              left: underline.left,
              top: underline.top,
              width: underline.width,
              height: underline.height,
            }}
          />
        )}
        {card && (
          <SymbolCard
            card={card}
            server={server}
            theme={theme}
            displayed={canReveal}
            onKeep={() => clearTimeout(closeTimer.current)}
            onLeave={() => {
              closeTimer.current = setTimeout(() => setCard(null), CLOSE_DELAY)
            }}
            onOpenDefinition={() => void openDefinition(card.query, null)}
            onReferences={
              onReferences &&
              ((answer) => {
                close()
                onReferences(card.query, answer)
              })
            }
          />
        )}
      </>
    ),
  }
}

function SymbolCard({
  card,
  server,
  theme,
  displayed,
  onKeep,
  onLeave,
  onOpenDefinition,
  onReferences,
}: {
  card: Card
  server: string | undefined
  theme: SyntaxTheme
  displayed: (path: string, line: number) => boolean
  onKeep: () => void
  onLeave: () => void
  onOpenDefinition: () => void
  onReferences?: (answer: SymbolAnswer) => void
}) {
  const { query, rect, lookup, expanded } = card
  const answer = lookup.status === 'done' ? lookup.answer : null
  const definition = answer?.definitions.find((found) => found.inRepo) ?? answer?.definitions[0]
  const showsDefinition = expanded && definition?.snippet !== undefined
  // Below the token, or above it when the lower half of the window is all there is.
  const above = rect.top > innerHeight / 2
  const width = Math.min(560, innerWidth - 16)
  const style = {
    left: Math.max(8, Math.min(rect.left - 12, innerWidth - width - 8)),
    width,
    ...(above ? { bottom: innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    maxHeight: (above ? rect.top : innerHeight - rect.bottom) - 18,
  }
  const name = definition?.path.slice(definition.path.lastIndexOf('/') + 1)
  return (
    <div
      className="symbol-card"
      role="dialog"
      aria-label={query.token}
      style={style}
      onMouseEnter={onKeep}
      onMouseLeave={onLeave}
    >
      <div className="symbol-card-head">
        <span>{server ?? answer?.server}</span>
        <span className="beta-badge">Beta</span>
      </div>
      <div className="symbol-card-body">
        {lookup.status === 'loading' && (
          <p className="symbol-card-status">Asking {server ?? 'the language server'}…</p>
        )}
        {lookup.status === 'error' && (
          <p className="symbol-card-status unavailable" role="alert">
            {lookup.message}
          </p>
        )}
        {answer?.hover.map((block, index) =>
          block.kind === 'code' ? (
            // The definition's own lines say what the hover's code would: for
            // a type, gopls hovers with the whole declaration.
            !showsDefinition && (
              <HighlightedCode
                key={index}
                className="symbol-signature"
                code={block.text}
                path={query.path}
                theme={theme}
              />
            )
          ) : (
            <p className="symbol-doc" key={index}>
              {block.text}
            </p>
          ),
        )}
        {answer && answer.hover.length === 0 && !definition && (
          <p className="symbol-card-status">Nothing is known about {query.token}.</p>
        )}
        {showsDefinition && definition?.snippet && (
          <HighlightedCode
            className="symbol-snippet"
            label={`${definition.path}:${definition.line}`}
            code={definition.snippet.lines.join('\n')}
            path={definition.path}
            theme={theme}
            start={definition.snippet.start}
            background
          />
        )}
      </div>
      {definition && (
        <div className="symbol-card-meta">
          {definition.inRepo ? (
            <>
              Defined in{' '}
              <b>
                {definition.path}:{definition.line}
              </b>
              {!displayed(definition.path, definition.line) && (
                <span className="symbol-tag">not in this diff</span>
              )}
            </>
          ) : (
            <span title={definition.path}>
              Defined outside the repository, in <b>{name}</b>
            </span>
          )}
        </div>
      )}
      <div className="symbol-card-actions">
        {/* Where the diff shows the definition, the click goes there; elsewhere
            it can only show its lines here. */}
        {definition?.inRepo && displayed(definition.path, definition.line) ? (
          <button type="button" onClick={onOpenDefinition}>
            Go to definition <kbd>⌘ click</kbd>
          </button>
        ) : (
          definition?.snippet &&
          !showsDefinition && (
            <button type="button" onClick={onOpenDefinition}>
              Show definition <kbd>⌘ click</kbd>
            </button>
          )
        )}
        {onReferences && (
          <button type="button" disabled={!answer} onClick={() => answer && onReferences(answer)}>
            References
          </button>
        )}
        <span className="symbol-card-hint">
          <kbd>esc</kbd>
        </span>
      </div>
    </div>
  )
}
