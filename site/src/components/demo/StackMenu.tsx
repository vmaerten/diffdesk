import { useEffect, useRef } from 'react'
import type { DemoLayer } from './fixtures.ts'

/** The app's stack picker: the layers top first, hung on one rail down to the trunk. */
export default function StackMenu({
  layers,
  current,
  trunk,
  onPick,
  onClose,
}: {
  layers: DemoLayer[]
  current: number
  trunk: string
  onPick: (index: number) => void
  onClose: () => void
}) {
  const list = useRef<HTMLOListElement>(null)

  useEffect(() => {
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      ?.focus({ preventScroll: true })
  }, [])

  // The list owns the keys while it is open; `s` closes it as it opened it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.target instanceof HTMLTextAreaElement) return
      if (event.key === 'Escape' || event.key === 's') {
        event.stopPropagation()
        event.preventDefault()
        onClose()
        return
      }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
      if (!step || !list.current) return
      event.preventDefault()
      const buttons = [...list.current.querySelectorAll<HTMLButtonElement>('button:enabled')]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(at + step + buttons.length) % buttons.length]?.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <>
      <div className="picker-backdrop" onMouseDown={onClose} />
      <div className="stack-picker" role="dialog" aria-label="Stack">
        <div className="stack-head">Stack</div>
        <ol className="stack-list" ref={list}>
          {layers
            .map((layer, index) => {
              const reviewing = index === current
              const badge = reviewing ? 'reviewing' : layer.pruned ? 'pruned' : null
              return (
                <li
                  key={layer.branch}
                  className={`stack-row${reviewing ? ' current' : ''}${layer.pruned ? ' merged' : ''}`}
                >
                  <span className="stack-node" aria-hidden="true" />
                  <button
                    type="button"
                    className="stack-branch"
                    aria-current={reviewing ? 'true' : undefined}
                    disabled={layer.pruned}
                    title={
                      layer.pruned
                        ? `${layer.branch} is merged and gone from this checkout`
                        : `Review ${layer.branch} against ${layer.base}`
                    }
                    onClick={() => onPick(index)}
                  >
                    {layer.branch}
                  </button>
                  <span className="stack-pr">#{layer.pr}</span>
                  {badge ? <span className={`badge ${badge}`}>{badge}</span> : <span />}
                </li>
              )
            })
            .toReversed()}
          <li className="stack-row stack-trunk">
            <span className="stack-node" aria-hidden="true" />
            <span className="stack-branch">{trunk}</span>
            <span />
            <span className="stack-note">trunk</span>
          </li>
        </ol>
        <div className="picker-foot">
          <kbd>[</kbd> <kbd>]</kbd> layer below / above · <kbd>esc</kbd> close
        </div>
      </div>
    </>
  )
}
