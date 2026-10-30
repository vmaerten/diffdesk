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
  image?: ImageComparison
}

export interface ImageVersion {
  url: string | null
  bytes?: number
  error?: string
}

export interface ImageComparison {
  before: ImageVersion | null
  after: ImageVersion | null
}

/**
 * Where a base came from. The UI shows it, because a wrong base produces a
 * misleading diff without ever looking wrong.
 */
export type BaseSource = 'override' | 'stack' | 'guessed' | 'trunk'

export interface BaseResolution {
  ref: string
  sha: string
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

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface RepoState {
  operation: RepoOperation | null
  conflicted: string[]
}

export interface RefDetail {
  name: string
  when: string
}

/** One commit of the range under review, as the picker lists it. */
export interface CommitDetail {
  sha: string
  short: string
  subject: string
  author: string
  /** Relative, as `RefDetail.when` is: the pickers show the two the same way. */
  when: string
  /** More than one means a merge, which is read against the first. */
  parents: string[]
  /**
   * null when git reported no counts — a merge, or a commit that changes
   * nothing. `--shortstat` says nothing about either, and 0 would be a claim.
   */
  additions: number | null
  deletions: number | null
  files: number | null
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
  /** The b-side path used by the comparison reader; '' for a comment on the whole review. */
  path: string
  side: DiffSide
  /**
   * 1-based in that side's version of the file. `end === start` for one line;
   * both 0 for the whole file, or the whole review without a path.
   */
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
  /** Reviewed branch at creation; absent in older state files. */
  branch?: string
  createdAt: string
  /** Resolved comments are closed but kept; absent until the server has it. */
  status?: CommentStatus
}

export type CommentStatus = 'open' | 'resolved'

/**
 * As served: whether the lines it was written against still read the same.
 *
 * In the nominal case this is a completion signal rather than a warning — an
 * agent was handed the remark and changed the lines. So it is shown next to what
 * they used to say, and cleared by hand.
 */
export interface ServedComment extends Comment {
  stale: boolean
  /**
   * Lines `start`..`end` as the current patch has them, or empty when the patch
   * no longer carries them.
   *
   * Served rather than re-derived by each reader: cutting them needs the patch,
   * and the export has to quote the code as it is *now* — the anchor is what it
   * was. Both the CLI and the copy button read this, so they cannot disagree.
   */
  code: string[]
}

/** `.git/ghl/state.json` as written. */
export interface StoredState {
  version: number
  viewed: Record<string, ViewedMap>
  /** Flat storage; readers select the reviewed branch's comments. */
  comments: Comment[]
}

export interface Comparison {
  before: string
  after: string | null
}

export interface DiffFiles {
  oldFile: { name: string; contents: string; cacheKey: string } | null
  newFile: { name: string; contents: string; cacheKey: string }
}

/** The body of `GET /r/:repoId/api/diff`. */
export interface DiffPayload {
  comparison: Comparison
  repo: { id: string; path: string }
  base: BaseResolution
  head: { branch: string | null; sha: string }
  /** What is under review, and whether uncommitted work is part of it. */
  target: { ref: string; workingTree: boolean }
  /**
   * The one commit being shown, or null for the whole range.
   *
   * Carried so the topbar can name it without opening the picker first, and
   * served rather than echoed back: a sha that no longer resolves falls back to
   * the range, and this field is how the UI learns which of the two it got.
   */
  commit: CommitDetail | null
  range: string
  state: RepoState
  untracked: string[]
  untrackedIncluded: boolean
  files: ServedFileStat[]
  totals: Totals
  viewed: ViewedMap
  /** Stable across base, commit and whitespace selection on the same branch. */
  commentBranch: string
  /** All comments on the reviewed branch, including files outside the diff. */
  comments: ServedComment[]
  /**
   * Something about the stored state the reader should know, or null.
   *
   * The server runs detached, so its stderr reaches nobody: a state file moved
   * aside has to travel with the payload or it is not reported at all.
   */
  notice: string | null
  patch: string
  /** The reviewed branch's walkthrough, placed on this diff; null when it has none. */
  walkthrough: ServedWalkthrough | null
}

/** Where a cited hunk is in the shown diff: its first row. */
export interface HunkPlace {
  id: string
  path: string
  side: DiffSide
  line: number
}

/** A hunk a walkthrough cites, by the ID it was written with; `at` is null once it is gone. */
export interface ServedHunk {
  id: string
  at: HunkPlace | null
}

export interface WalkthroughStop {
  title: string
  summary: string
  prose: string
  hunks: ServedHunk[]
}

/** The body of `diffdesk walkthrough set`, as `GET …/api/diff` serves it. */
export interface ServedWalkthrough {
  title: string
  focus: string
  author: string
  createdAt: string
  range: string
  workingTree: boolean
  /** Written for another comparison of the branch: its hunks were found by content. */
  elsewhere: boolean
  /** Half its hunks or more are gone. */
  stale: boolean
  chapters: { title: string; stops: WalkthroughStop[] }[]
  support: { note: string; hunks: ServedHunk[] }[]
  /** This diff's hunks that no stop or support group names. */
  uncited: string[]
  /** Stops read in the app, numbered across chapters. */
  read: number[]
}

/** The body of `GET /r/:repoId/api/walkthrough/generate`: the agents, and the branch's generation. */
export interface GenerationStatus {
  agents: { id: string; label: string; found: boolean }[]
  /** The agent writing the walkthrough. */
  running?: string
  failed?: { agent: string; log: string }
}

/** The body of `GET /r/:repoId/api/refs`. */
export interface RefsPayload {
  refs: RefDetail[]
  trunk: string | null
  branch: string | null
}

/** The body of `GET /r/:repoId/api/commits`. */
export interface CommitsPayload {
  commits: CommitDetail[]
}

/** A language's server in one checkout, as `GET /r/<id>/api/lsp` reports it. */
export interface LanguageStatus {
  id: string
  label: string
  extensions: string[]
  /** For Helm, the charts' templates folders: the language owns no other file. */
  directories?: string[]
  choice: string
  choices: string[]
  /** The server this checkout would run, or null when none is found. */
  server: { name: string; path: string; origin: 'checkout' | 'PATH' } | null
  version?: string
  state: 'off' | 'missing' | 'idle' | 'starting' | 'indexing' | 'ready' | 'failed'
  progress?: { title: string; message?: string; percentage?: number }
  /** How to install a missing server. */
  install?: string
  /** The installs the page may run, by the managers this machine has. */
  installs?: { manager: string; command: string }[]
  /** The manager installing the server now. */
  installing?: string
  installError?: { manager: string; log: string }
  /** Why the server failed, with the end of its stderr. */
  error?: string
}

export interface LanguageServersStatus {
  enabled: boolean
  languages: LanguageStatus[]
  workspace?: { kind: 'working-tree' | 'revision'; revision?: string; path?: string }
}

/** A token the diff shows, as the code intelligence routes take it. */
export interface SymbolQuery {
  /** Exact new-side commit; omitted when querying the working tree. */
  revision?: string
  path: string
  /** From 1, as the diff counts lines. */
  line: number
  /** In UTF-16 units, as JavaScript counts them. */
  character: number
  token: string
}

/** A hover's Markdown, cut into signatures and prose. */
export interface HoverBlock {
  kind: 'code' | 'text'
  language?: string
  text: string
}

export interface SymbolDefinition {
  /** Repository-relative when `inRepo`, absolute otherwise. */
  path: string
  line: number
  character: number
  inRepo: boolean
  /** The definition's first lines, for one inside the repository. */
  snippet?: { start: number; lines: string[] }
}

/** `GET /r/<id>/api/lsp/symbol`. */
export interface SymbolAnswer {
  language: string
  server: string
  hover: HoverBlock[]
  definitions: SymbolDefinition[]
}

export interface SymbolReference {
  path: string
  line: number
  /** The reference's columns, in UTF-16 units. */
  character: number
  endCharacter: number
  text: string
}

/** `GET /r/<id>/api/lsp/references`: the repository's references, sorted by path and line. */
export interface ReferencesAnswer {
  references: SymbolReference[]
  /** References outside the repository, such as in a module cache. */
  external: number
  truncated: boolean
}

/** How Diffdesk reaches GitHub, through its CLI: anything but ready shows no pull request. */
export type GitHubState = 'ready' | 'missing' | 'signed-out' | 'unavailable'

export interface PullRequest {
  number: number
  title: string
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  author: string
  base: string
  review: 'approved' | 'changes-requested' | 'required' | ''
  approvedBy: string[]
  changesRequestedBy: string[]
  requested: string[]
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  /** The local branch against the pull request's head; null when the checkout lacks that head. */
  sync: { ahead: number; behind: number } | null
  /** The branch is checked out with changes to tracked files. */
  uncommitted: boolean
  /** The commit GitHub ran the checks on. */
  head: string
  /** Check runs and commit statuses, the latest run of each. */
  checks: Check[]
}

export interface Check {
  name: string
  state: 'passed' | 'failed' | 'skipped' | 'running' | 'pending'
  url: string
  startedAt?: string
  completedAt?: string
}

/** The body of `GET /r/:repoId/api/pull-request?branch=`. */
export interface PullRequestPayload {
  github: GitHubState
  message?: string
  pullRequest: PullRequest | null
}

/** The body of `GET /api/github`: who the GitHub CLI is signed in as. */
export interface GitHubAccount {
  github: GitHubState
  message?: string
  login?: string
}
