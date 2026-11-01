import { useCallback, useEffect, useState } from 'react'
import DesktopSheet from './DesktopSheet.tsx'
import { WALKTHROUGH_AGENT_LABELS, type WalkthroughAgent } from './desktopSettings.ts'
import type { GenerationStatus } from '../../src/types.ts'

type Method = 'GET' | 'POST' | 'DELETE'

/**
 * The branch's walkthrough generation, which Go runs. Polls while an agent
 * writes, and calls onDone once it has saved the walkthrough.
 */
export function useWalkthroughGeneration(
  repoId: string | null,
  branch: string | undefined,
  query: string | undefined,
  onDone: () => void,
) {
  const [status, setStatus] = useState<GenerationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useCallback(
    async (method: Method, agent?: string): Promise<GenerationStatus | null> => {
      if (!repoId || !branch || query === undefined) return null
      // POST reads the comparison from the selection, GET and DELETE the branch.
      const params = new URLSearchParams(query)
      params.set('branch', branch)
      try {
        const response = await fetch(
          `/r/${repoId}/api/walkthrough/generate?${params}`,
          method === 'POST'
            ? {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent }),
              }
            : { method },
        )
        const body: GenerationStatus & { error?: string } = await response.json()
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
        setStatus(body)
        setError(null)
        return body
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
        return null
      }
    },
    [repoId, branch, query],
  )
  useEffect(() => {
    if (!status?.running) return
    const timer = setTimeout(async () => {
      const next = await request('GET')
      if (next && !next.running && !next.failed) onDone()
    }, 1000)
    return () => clearTimeout(timer)
  }, [status, request, onDone])
  return {
    status,
    error,
    check: () => void request('GET'),
    start: (agent: string) => void request('POST', agent),
    /** Stops the agent, or forgets its failure. */
    cancel: () => void request('DELETE'),
  }
}

/** Says what Generate sends and to whom, then follows the agent writing. */
export default function GenerateWalkthrough({
  agent,
  status,
  error,
  files,
  additions,
  deletions,
  replaces,
  onGenerate,
  onCancel,
  onClose,
}: {
  agent: Exclude<WalkthroughAgent, 'off'>
  status: GenerationStatus | null
  error: string | null
  files: number
  additions: number
  deletions: number
  replaces: boolean
  onGenerate: () => void
  onCancel: () => void
  onClose: () => void
}) {
  const found = status?.agents.find((entry) => entry.id === agent)
  const label = WALKTHROUGH_AGENT_LABELS[agent]
  const failed = status?.failed
  let action = (
    <button type="button" className="button" disabled={!found?.found} onClick={onGenerate}>
      Generate
    </button>
  )
  if (status?.running)
    action = (
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
    )
  else if (failed)
    action = (
      <button type="button" className="button" onClick={onGenerate}>
        Try Again
      </button>
    )
  return (
    <DesktopSheet
      open
      title="Generate Walkthrough"
      className="generate-sheet"
      onClose={onClose}
      actions={action}
    >
      {status?.running ? (
        <p className="generate-running" role="status">
          <span className="install-spinner" aria-hidden="true" />
          {status.running} is writing the walkthrough… It opens here once saved; you can close this
          sheet meanwhile.
        </p>
      ) : failed ? (
        <>
          <p role="alert">{failed.agent} couldn’t write it.</p>
          <pre className="generate-log">{failed.log}</pre>
        </>
      ) : (
        <>
          <p>
            {label} reads this diff, {files} {files === 1 ? 'file' : 'files'} with +{additions} −
            {deletions} lines, and writes a tour of it.
            {replaces && ' It replaces this branch’s walkthrough.'}
          </p>
          <p className="generate-note">
            The diff goes to {label}’s provider, signed in as you: Diffdesk keeps no key. The agent
            gets no tool that writes.
          </p>
          {found && !found.found && (
            <p className="generate-missing" role="alert">
              {label} isn’t installed: <code>{agent}</code> isn’t on your login shell’s PATH.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="generate-missing" role="alert">
          {error}
        </p>
      )}
    </DesktopSheet>
  )
}
