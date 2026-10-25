import { useEffect, useState } from 'react'
import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs'
import type { SyntaxTheme } from './theme.ts'

export interface HighlightedCode {
  fg: string
  bg: string
  lines: { content: string; color?: string; italic: boolean; bold: boolean }[][]
}

const highlighted = new Map<string, Promise<HighlightedCode | null>>()

/**
 * A few lines in the review's syntax theme, for the symbol card.
 *
 * The diff highlights in workers; these snippets are short enough for the main
 * thread's highlighter, which loads their language on first use.
 */
function highlight(
  code: string,
  path: string,
  theme: SyntaxTheme,
): Promise<HighlightedCode | null> {
  const language = getFiletypeFromFileName(path)
  const key = `${theme}\u0000${language}\u0000${code}`
  let result = highlighted.get(key)
  if (!result) {
    result = (async () => {
      try {
        const highlighter = await getSharedHighlighter({ themes: [theme], langs: [language] })
        const {
          tokens,
          fg = '',
          bg = '',
        } = highlighter.codeToTokens(code, { lang: language, theme })
        return {
          fg,
          bg,
          lines: tokens.map((line) =>
            line.map((token) => ({
              content: token.content,
              color: token.color,
              // Shiki's FontStyle flags.
              italic: ((token.fontStyle ?? 0) & 1) !== 0,
              bold: ((token.fontStyle ?? 0) & 2) !== 0,
            })),
          ),
        }
      } catch {
        // An unknown language stays plain.
        return null
      }
    })()
    highlighted.set(key, result)
  }
  return result
}

/** The code highlighted as path's language, or null until it is (or if it cannot be). */
export function useHighlighted(code: string, path: string, theme: SyntaxTheme) {
  const [result, setResult] = useState<HighlightedCode | null>(null)
  useEffect(() => {
    let current = true
    setResult(null)
    const load = async () => {
      const next = await highlight(code, path, theme)
      if (current) setResult(next)
    }
    void load()
    return () => {
      current = false
    }
  }, [code, path, theme])
  return result
}
