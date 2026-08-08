/**
 * The shapes that cross the HTTP boundary.
 *
 * They live apart from the modules that build them so the front end can import
 * them in one go rather than restate them — see #19.
 */

/** What `git diff --name-status` reports, plus the one git cannot: untracked. */
export type GitStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'

/** A file's line counts, straight from `git diff --numstat`. */
export interface FileCounts {
  path: string
  additions: number
  deletions: number
  binary: boolean
}

export interface FileStat extends FileCounts {
  status: GitStatus
}

/** As served: the hash identifies the diff section a viewed tick was set on. */
export interface ServedFileStat extends FileStat {
  hash: string | null
}

/**
 * Where a base came from. The UI shows it, because a wrong base produces a
 * misleading diff without ever looking wrong.
 */
export type BaseSource = 'override' | 'remembered' | 'stack' | 'guessed' | 'trunk'

export interface BaseResolution {
  ref: string
  source: BaseSource
  branch: string | null
  trunk: string | null
  distance?: number
}

export interface Totals {
  files: number
  additions: number
  deletions: number
}

/** One branch of a `gh stack` chain, and what it should be diffed against. */
export interface StackLayer {
  branch: string
  /** The branch this layer sits on: the nearest live layer below, or the trunk. */
  base: string
  pr: { number: number; url: string; merged: boolean } | null
  merged: boolean
  /** False once the branch is pruned: the layer can be shown, not opened. */
  exists: boolean
}

export interface StackChain {
  trunk: string
  /** Bottom (closest to the trunk) first, the order `gh stack` records. */
  layers: StackLayer[]
  /** Index in `layers` of what is under review, -1 when it is not one of them. */
  current: number
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick'

export interface RepoState {
  operation: RepoOperation | null
  conflicted: string[]
}

export interface RefDetail {
  name: string
  when: string
  remote: boolean
}

/** path -> hash of the diff section that was marked as read, or null. */
export type ViewedMap = Record<string, string | null>

export interface PatchResult {
  patch: string
  untracked: string[]
  untrackedIncluded: boolean
  files: FileStat[]
  totals: Totals
}

/** The body of `GET /r/:repoId/api/diff`. */
export interface DiffPayload {
  repo: { id: string; path: string }
  base: BaseResolution
  head: { branch: string | null; sha: string }
  /** What is under review, and whether uncommitted work is part of it. */
  target: { ref: string; workingTree: boolean }
  /** The chain the reviewed branch belongs to, or null when it belongs to none. */
  stack: StackChain | null
  range: string
  state: RepoState
  untracked: string[]
  untrackedIncluded: boolean
  files: ServedFileStat[]
  totals: Totals
  viewed: ViewedMap
  patch: string
}

/** The body of `GET /r/:repoId/api/refs`. */
export interface RefsPayload {
  refs: RefDetail[]
  trunk: string | null
  branch: string | null
}
