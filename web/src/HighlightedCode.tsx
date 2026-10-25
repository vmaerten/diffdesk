import type { SyntaxTheme } from './theme.ts'
import { useHighlighted } from './highlight.ts'

/** Code in the review's syntax theme, plain until its highlighting arrives. */
export default function HighlightedCode({
  code,
  path,
  theme,
  start,
  className,
  label,
  background = false,
}: {
  code: string
  /** The file the code comes from, which names its language. */
  path: string
  theme: SyntaxTheme
  /** Numbers the lines from here. */
  start?: number
  className: string
  label?: string
  /** Paints the theme's background, for a block of code rather than a line of prose. */
  background?: boolean
}) {
  const highlighted = useHighlighted(code, path, theme)
  return (
    <pre
      className={className}
      aria-label={label}
      style={
        highlighted
          ? { color: highlighted.fg, background: background ? highlighted.bg : undefined }
          : undefined
      }
    >
      {code.split('\n').map((line, index, lines) => (
        <span key={index}>
          {start !== undefined && <i>{start + index}</i>}
          {highlighted?.lines[index]?.map((token, position) => (
            <span
              key={position}
              style={{
                color: token.color,
                fontStyle: token.italic ? 'italic' : undefined,
                fontWeight: token.bold ? 600 : undefined,
              }}
            >
              {token.content}
            </span>
          )) ?? line}
          {index < lines.length - 1 && '\n'}
        </span>
      ))}
    </pre>
  )
}
