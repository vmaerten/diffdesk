import type { FileDiffContentsLoader } from '@pierre/diffs'
import type { DiffFiles, DiffPayload } from '../../src/types.ts'

export interface ContextError {
  message: string
  retry: () => void
}

/** Keep the library's pending expansion alive on failure, until Retry succeeds. */
export function diffFilesLoader(
  repoId: string,
  data: DiffPayload,
  query: string,
  signal: AbortSignal,
  onError: (path: string, error: ContextError | null) => void,
): FileDiffContentsLoader {
  const requests = new Map<string, Promise<DiffFiles>>()
  return (file) => {
    const previous = requests.get(file.name)
    if (previous) return previous
    const pending = new Promise<DiffFiles>((resolve) => {
      let running = false
      const attempt = async () => {
        if (running || signal.aborted) return
        running = true
        onError(file.name, null)
        try {
          const params = new URLSearchParams(query)
          params.set('path', file.name)
          params.set('hash', data.files.find((entry) => entry.path === file.name)?.hash ?? '')
          params.set('comparison', JSON.stringify(data.comparison))
          const response = await fetch(`/r/${repoId}/api/diff-files?${params}`, { signal })
          const body: DiffFiles & { error?: string } = await response.json()
          if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
          if (!signal.aborted) resolve(body)
        } catch (error) {
          if (!signal.aborted)
            onError(file.name, {
              message: error instanceof Error ? error.message : String(error),
              retry: () => {
                void attempt()
              },
            })
        } finally {
          running = false
        }
      }
      void attempt()
    })
    requests.set(file.name, pending)
    return pending
  }
}
