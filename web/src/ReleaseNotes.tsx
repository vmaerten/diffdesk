import Markdown from 'react-markdown'
import type { ComponentProps } from 'react'

function ReleaseLink({ href, children }: ComponentProps<'a'>) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

const components = { a: ReleaseLink }

/** Release Markdown becomes React elements; raw HTML and remote images are omitted. */
export default function ReleaseNotes({ notes, version }: { notes: string; version: string }) {
  return notes ? (
    <Markdown skipHtml disallowedElements={['img']} components={components}>
      {notes}
    </Markdown>
  ) : (
    <p>
      Release notes aren’t available for this version yet.{' '}
      <a
        href={`https://github.com/vmaerten/diffdesk/releases/tag/v${encodeURIComponent(version)}`}
        target="_blank"
        rel="noreferrer"
      >
        View the release on GitHub
      </a>
      .
    </p>
  )
}
