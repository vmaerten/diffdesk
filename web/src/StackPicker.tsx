import { useEffect, useRef } from 'react'
import type { StackChain, StackLayer } from '../../src/types.ts'

/** The directory every layer's branch shares, such as `desktop-ui/`, or ''. */
export function stackPrefix(stack: StackChain): string {
  let prefix = stack.layers[0]?.branch ?? ''
  for (const { branch } of stack.layers)
    while (!branch.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return prefix.slice(0, prefix.lastIndexOf('/') + 1)
}

/**
 * The target that reviews a layer. The checked-out branch goes through the
 * working tree rather than its own ref, or uncommitted work drops out of the diff.
 */
export const layerTarget = (layer: StackLayer, headBranch: string | null | undefined) =>
  layer.branch === headBranch ? null : layer.branch

/** The nearest layer left to open above (1) or below (-1) the one under review. */
export function neighbourLayer(stack: StackChain, step: 1 | -1): StackLayer | null {
  for (let index = stack.current + step; index >= 0 && index < stack.layers.length; index += step)
    if (stack.layers[index]!.exists) return stack.layers[index]!
  return null
}

function badge(layer: StackLayer, current: boolean) {
  if (current) return 'reviewing'
  if (!layer.exists) return layer.merged ? 'pruned' : 'gone'
  return layer.merged ? 'merged' : null
}

/** The stack under review, top layer first, opened from the capsule's stack button. */
export default function StackPicker({
  stack,
  headBranch,
  onPick,
  onClose,
}: {
  stack: StackChain
  headBranch: string | null | undefined
  onPick: (ref: string | null) => void
  onClose: () => void
}) {
  const list = useRef<HTMLOListElement>(null)
  const prefix = stackPrefix(stack)

  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus()
  }, [])

  // The list owns the keys while it is open; `s` closes it as it opened it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
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
      <div
        className="picker stack-picker"
        role="dialog"
        aria-label="Stack"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="stack-head">Stack {prefix && <code>{prefix}</code>}</div>
        <ol className="stack-list" ref={list}>
          {stack.layers
            .map((layer, index) => {
              const current = index === stack.current
              const label = badge(layer, current)
              return (
                <li
                  key={layer.branch}
                  className={`stack-row${current ? ' current' : ''}${layer.merged ? ' merged' : ''}`}
                  data-branch={layer.branch}
                >
                  <span className="stack-node" aria-hidden="true" />
                  <button
                    type="button"
                    className="stack-branch"
                    aria-current={current ? 'true' : undefined}
                    disabled={!layer.exists}
                    title={
                      layer.exists
                        ? `Review ${layer.branch} against ${layer.base}`
                        : `${layer.branch} is gone from this checkout`
                    }
                    onClick={() => onPick(layerTarget(layer, headBranch))}
                  >
                    {layer.branch.slice(prefix.length)}
                  </button>
                  {layer.pr ? (
                    <a
                      className="stack-pr"
                      href={layer.pr.url}
                      target="_blank"
                      rel="noreferrer"
                      title={`Pull request #${layer.pr.number} on GitHub`}
                    >
                      #{layer.pr.number}
                    </a>
                  ) : (
                    <span />
                  )}
                  {label ? <span className={`badge ${label}`}>{label}</span> : <span />}
                </li>
              )
            })
            .toReversed()}
          <li className="stack-row stack-trunk">
            <span className="stack-node" aria-hidden="true" />
            <span className="stack-branch">{stack.trunk}</span>
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
