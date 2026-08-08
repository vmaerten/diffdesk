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
  /**
   * The chain the branch belongs to, or null when it belongs to none.
   *
   * Carried here because resolving the base is what reads it: the UI shows both,
   * and computing them apart is how the two come to disagree.
   */
  stack: StackChain | null
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
  pr: { number: number; url: string } | null
  merged: boolean
  /** False once the branch is pruned: the layer can be shown, not opened. */
  exists: boolean
}

export interface StackChain {
  trunk: string
  /** Bottom (closest to the trunk) first, the order `gh stack` records. */
  layers: StackLayer[]
  /** Index in `layers` of what is under review; the chain was found by it. */
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

/**
 * Which version of a file a line number counts in.
 *
 * The names are the diff pane's, so the two never need translating: deletions
 * are the old file, additions the new one.
 */
export type DiffSide = 'deletions' | 'additions'

/**
 * A remark on a range of lines, written to be handed to an agent.
 *
 * Anchored on a path and a side rather than on a diff item's id: those embed the
 * head sha and change on every commit. Anchored on the lines' own text too, so a
 * remark can say it no longer describes what it was written against.
 */
export interface Comment {
  id: string
  /** The b-side path, as the keys of `sectionHashes` are. */
  path: string
  side: DiffSide
  /** 1-based in that side's version of the file. `end === start` for one line. */
  start: number
  end: number
  body: string
  /** Lines `start`..`end` as they read when it was written. */
  anchor: string[]
  /**
   * What was being compared when it was written.
   *
   * Provenance, never a key. Filing comments by range would hide them whenever
   * `resolveBase` changed its mind on its own — a guessed base, or a `gh stack`
   * chain that moved — which is the tool erasing written text, not the user.
   */
  range: string
  createdAt: string
}

/** `.git/ghl/state.json` as written. */
export interface StoredState {
  version: number
  viewed: Record<string, ViewedMap>
  /** Flat: a comment belongs to the code it points at, not to a comparison. */
  comments: Comment[]
}

/** The state, and anything reading it had to report. */
export interface StateRead {
  state: StoredState
  /** Set when the file had to be moved aside. Shown, not swallowed. */
  notice: string | null
}

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
  range: string
  state: RepoState
  untracked: string[]
  untrackedIncluded: boolean
  files: ServedFileStat[]
  totals: Totals
  viewed: ViewedMap
  /** Only those on a file this diff contains; the rest are for another diff. */
  comments: Comment[]
  /**
   * Something about the stored state the reader should know, or null.
   *
   * The server runs detached, so its stderr reaches nobody: a state file moved
   * aside has to travel with the payload or it is not reported at all.
   */
  notice: string | null
  patch: string
}

/** The body of `GET /r/:repoId/api/refs`. */
export interface RefsPayload {
  refs: RefDetail[]
  trunk: string | null
  branch: string | null
}
