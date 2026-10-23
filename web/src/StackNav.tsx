import type { StackChain } from '../../src/types.ts'

export default function StackNav({
  stack,
  headBranch,
  onPickTarget,
}: {
  stack: StackChain
  headBranch?: string | null
  onPickTarget: (ref: string | null) => void
}) {
  return (
    <nav className="stack" aria-label="Stack">
      <span>{stack.trunk}</span>
      {stack.layers.map((layer, index) => (
        <span
          key={layer.branch}
          className={`stack-layer${index === stack.current ? ' current' : ''}${
            layer.merged ? ' merged' : ''
          }`}
        >
          <span className="arrow">→</span>
          <button
            type="button"
            className="ref stack-name"
            aria-current={index === stack.current ? 'true' : undefined}
            disabled={!layer.exists}
            title={
              layer.exists
                ? `Review ${layer.branch} against ${layer.base}`
                : `${layer.branch} is gone from this checkout`
            }
            // The checked-out branch goes through the working tree rather
            // than its own ref, or uncommitted work drops out of the diff.
            onClick={() => onPickTarget(layer.branch === headBranch ? null : layer.branch)}
          >
            {layer.branch}
          </button>
          {layer.pr && (
            <a
              className="stack-pr"
              href={layer.pr.url}
              target="_blank"
              rel="noreferrer"
              title={`Pull request #${layer.pr.number} on GitHub`}
            >
              #{layer.pr.number}
            </a>
          )}
          {layer.merged && <span className="badge">merged</span>}
        </span>
      ))}
    </nav>
  )
}
