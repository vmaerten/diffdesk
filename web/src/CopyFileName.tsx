import { useEffect, useRef, useState } from 'react'

import Icon from './Icon.tsx'

export default function CopyFileName({ path }: { path: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const message =
    status === 'copied'
      ? 'File name copied'
      : status === 'error'
        ? 'Could not copy. Check clipboard permissions and try again.'
        : ''

  return (
    <span className="file-copy" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="file-copy-button"
        data-status={status}
        aria-label={`Copy file name: ${path}`}
        title={message || 'Copy file name'}
        onClick={async () => {
          if (timer.current) clearTimeout(timer.current)
          try {
            await navigator.clipboard.writeText(path)
            setStatus('copied')
            timer.current = setTimeout(() => setStatus('idle'), 2000)
          } catch {
            setStatus('error')
          }
        }}
      >
        <Icon name={status === 'copied' ? 'check' : 'copy'} />
      </button>
      <span className={status === 'error' ? 'file-copy-error' : 'visually-hidden'} role="status">
        {message}
      </span>
    </span>
  )
}
