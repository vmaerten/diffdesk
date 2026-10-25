import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LanguageServersStatus,
  LanguageStatus,
  ReferencesAnswer,
  SymbolAnswer,
  SymbolQuery,
} from '../../src/types.ts'
import type { DesktopSettings } from './desktopSettings.ts'

export const SERVER_CHOICE_LABELS: Record<string, string> = {
  auto: 'Auto',
  off: 'Off',
  tsc: 'TypeScript 7 (tsc)',
  tsrs: 'tsrs',
  'typescript-language-server': 'typescript-language-server',
}

async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new Error(body?.error ?? `HTTP ${response.status}`)
}

/** The settings the review server needs, as `PUT /api/lsp` takes them. */
export function languageConfig(settings: DesktopSettings): string {
  return JSON.stringify({ enabled: settings.codeIntelligence, servers: settings.languageServers })
}

/** Tells the review server what Settings say: no server starts before it hears it is on. */
export async function sendLanguageConfig(config: string): Promise<void> {
  const response = await fetch('/api/lsp', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: config,
  })
  if (!response.ok) throw await failure(response)
  // Read even when unused: a body left unread keeps the request open in the page.
  await response.arrayBuffer()
}

const BUSY = new Set<LanguageStatus['state']>(['starting', 'indexing'])

/**
 * What each language's server is doing in this checkout, or null until known.
 *
 * `revision` changes whenever the settings reach the server; null stops
 * asking. Polled while a server starts or indexes, so its progress shows.
 */
export function useLanguageStatus(
  repoId: string | null,
  revision: number | null,
): [LanguageServersStatus | null, () => void] {
  const [status, setStatus] = useState<LanguageServersStatus | null>(null)
  const [asked, setAsked] = useState(0)
  const active = repoId !== null && revision !== null
  const refresh = useCallback(() => setAsked((count) => count + 1), [])
  const latest = useRef(0)
  useEffect(() => {
    if (!active) {
      setStatus(null)
      return
    }
    const request = ++latest.current
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const response = await fetch(`/r/${repoId}/api/lsp`, { signal: controller.signal })
      if (!response.ok) throw await failure(response)
      const next = (await response.json()) as LanguageServersStatus
      if (request !== latest.current) return
      setStatus(next)
      if (next.languages.some((language) => BUSY.has(language.state)))
        timer = setTimeout(refresh, 1000)
    }
    // A failed look leaves the last known state; the next change asks again.
    load().catch(() => {})
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [active, repoId, revision, asked, refresh])
  return [status, refresh]
}

/** The languages of these paths that code intelligence covers. */
export function languagesOf(
  status: LanguageServersStatus | null,
  paths: readonly string[],
): LanguageStatus[] {
  if (!status) return []
  const extensions = new Set(
    paths.map((path) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      return dot > 0 ? name.slice(dot).toLowerCase() : ''
    }),
  )
  return status.languages.filter(
    (language) =>
      language.state !== 'off' &&
      language.extensions.some((extension) => extensions.has(extension)),
  )
}

/** A server's path as a home-relative one, which is how people read them. */
export function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/)/, '~')
}

export function stateLabel(language: LanguageStatus): string {
  switch (language.state) {
    case 'off':
      return 'Off'
    case 'missing':
      return 'Missing'
    case 'idle':
      return 'Not started'
    case 'starting':
      return 'Starting…'
    case 'indexing': {
      const percentage = language.progress?.percentage
      return percentage === undefined ? 'Indexing…' : `Indexing ${percentage} %`
    }
    case 'ready':
      return 'Running'
    case 'failed':
      return 'Failed'
  }
}

/** What the review server accepts as a token: an identifier, nothing around it. */
export const IDENTIFIER = /^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]*$/u

/** The file changed on disk since the review loaded: a refresh is needed first. */
export class StaleSymbolError extends Error {}

async function ask<T>(
  route: 'symbol' | 'references',
  repoId: string,
  query: SymbolQuery,
  signal?: AbortSignal,
): Promise<T> {
  const params = new URLSearchParams({
    path: query.path,
    line: String(query.line),
    character: String(query.character),
    token: query.token,
  })
  const response = await fetch(`/r/${repoId}/api/lsp/${route}?${params}`, { signal })
  if (response.status === 409) throw new StaleSymbolError((await failure(response)).message)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as T
}

export const lookUpSymbol = (repoId: string, query: SymbolQuery, signal?: AbortSignal) =>
  ask<SymbolAnswer>('symbol', repoId, query, signal)

export const lookUpReferences = (repoId: string, query: SymbolQuery, signal?: AbortSignal) =>
  ask<ReferencesAnswer>('references', repoId, query, signal)

/** The language server that answers for path, if one can. */
export function serverFor(languages: readonly LanguageStatus[], path: string) {
  const language = languagesOf({ enabled: true, languages: [...languages] }, [path])[0]
  return language && language.state !== 'missing' ? language : undefined
}
