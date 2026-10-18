import { createReviewSelection } from '../web/src/reviewSelection.ts'
import type { Check } from './harness.ts'

export async function runReviewSelection(check: Check): Promise<void> {
  let url = new URL(
    'http://localhost/r/test?base=release&target=feature&commit=abc&committed&untracked&extra=keep#file',
  )
  const remembered: { base: string; target: string | null }[] = []
  let fail = false
  let delay: Promise<void> | undefined
  const selection = createReviewSelection(url, {
    replaceUrl: (next) => {
      url = next
    },
    rememberBase: async (base, target) => {
      remembered.push({ base, target })
      await delay
      if (fail) throw new Error('write failed')
    },
    worktreeForTarget: async () => null,
    navigate: () => {
      throw new Error('unexpected worktree navigation')
    },
  })
  const initial = selection.getSnapshot()
  check(
    'selection carries the explicit base and all scope controls',
    initial.query === '?base=release&target=feature&commit=abc&committed=1&untracked=1',
  )
  let publications = 0
  const unsubscribe = selection.subscribe(() => {
    publications++
  })
  await selection.pickTarget('other/ref')
  const target = selection.getSnapshot()
  check(
    'changing target clears the old commit in state and URL',
    target.target === 'other/ref' && target.commit === null && !url.searchParams.has('commit'),
  )
  check(
    'target changes preserve base, scope flags, unrelated parameters and fragment',
    target.query === '?base=release&target=other%2Fref&committed=1&untracked=1' &&
      url.searchParams.get('extra') === 'keep' &&
      url.hash === '#file',
  )
  selection.pickCommit('def')
  check(
    'commit selection reaches both the URL and request scope',
    url.searchParams.get('commit') === 'def' &&
      selection.getSnapshot().query.includes('commit=def'),
  )
  selection.pickCommit(null)
  await selection.pickTarget(null)
  check(
    'whole-range checkout selection removes parameters instead of remembering defaults',
    !url.searchParams.has('target') && !url.searchParams.has('commit'),
  )
  selection.toggleCommitted()
  selection.toggleUntracked()
  check(
    'scope toggles clear flags in the URL and request',
    selection.getSnapshot().query === '?base=release' &&
      !url.searchParams.has('committed') &&
      !url.searchParams.has('untracked'),
  )
  selection.toggleCommitted()
  selection.toggleCommitted()
  check('consecutive toggles read the latest selection', !selection.getSnapshot().committed)

  fail = true
  const beforeFailure = selection.getSnapshot()
  await selection.pickBase('main', 'release').catch(() => {})
  check(
    'failed base persistence preserves the override and loaded selection',
    selection.getSnapshot() === beforeFailure && url.searchParams.get('base') === 'release',
  )
  fail = false
  await selection.pickBase('main', 'release')
  check(
    'remembered base replaces the explicit override only after success',
    !url.searchParams.has('base') &&
      selection.getSnapshot().query === '' &&
      remembered.at(-1)?.target === null,
  )
  const beforeRemember = selection.getSnapshot()
  await selection.pickBase('release', 'main')
  check(
    'remembering a base triggers a fresh selection even when the query stays empty',
    selection.getSnapshot() !== beforeRemember && selection.getSnapshot().query === '',
  )
  const beforeNoop = selection.getSnapshot()
  await selection.pickBase('release', 'release')
  check('picking the displayed base does not reload', selection.getSnapshot() === beforeNoop)

  let release!: () => void
  delay = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = selection.pickBase('main', 'release')
  await Promise.resolve()
  await selection.pickTarget('feature')
  const afterNavigation = selection.getSnapshot()
  release()
  await pending
  check(
    'late base persistence cannot change another target selection',
    selection.getSnapshot() === afterNavigation && remembered.at(-1)?.target === null,
  )
  delay = undefined
  await selection.pickBase('release', 'main')
  check('base persistence belongs to the reviewed target', remembered.at(-1)?.target === 'feature')
  check('selection changes notify subscribers', publications > 0)
  unsubscribe()
  const beforeUnsubscribe = publications
  selection.pickCommit('last')
  check('unsubscribed readers receive no further notifications', publications === beforeUnsubscribe)

  selection.toggleWhitespace()
  check(
    'whitespace filtering is an explicit URL and request setting',
    selection.getSnapshot().ignoreWhitespace &&
      url.searchParams.get('w') === '1' &&
      selection.getSnapshot().query.includes('w=1'),
  )
  await selection.pickTarget('other')
  selection.pickCommit('next')
  selection.toggleCommitted()
  selection.toggleUntracked()
  await selection.pickBase('main', 'release')
  check(
    'changing revision and scope preserves whitespace filtering',
    selection.getSnapshot().ignoreWhitespace && url.searchParams.get('w') === '1',
  )
  const reloaded = createReviewSelection(url, {
    replaceUrl: () => {},
    rememberBase: async () => {},
    worktreeForTarget: async () => null,
    navigate: () => {},
  })
  check('a reloaded URL restores the filter', reloaded.getSnapshot().ignoreWhitespace)
  selection.toggleWhitespace()
  check(
    'disabling whitespace filtering removes its URL parameter',
    !selection.getSnapshot().ignoreWhitespace && !url.searchParams.has('w'),
  )
  const disabled = createReviewSelection(new URL('http://localhost/r/test?w=0'), {
    replaceUrl: () => {},
    rememberBase: async () => {},
    worktreeForTarget: async () => null,
    navigate: () => {},
  })
  check('w=0 keeps the full diff', !disabled.getSnapshot().ignoreWhitespace)

  let worktreeUrl = new URL(
    'http://localhost/r/original?base=release&target=old&commit=abc&committed&untracked&w=1&extra=keep#file',
  )
  const navigations: URL[] = []
  let worktreeId: string | null = 'linked worktree é'
  let targetDelay: Promise<void> | undefined
  let targetFail = false
  const worktrees = createReviewSelection(worktreeUrl, {
    replaceUrl: (next) => {
      worktreeUrl = next
    },
    rememberBase: async () => {},
    worktreeForTarget: async () => {
      const id = worktreeId
      await targetDelay
      if (targetFail) throw new Error('worktree lookup failed')
      return id
    },
    navigate: (next) => {
      navigations.push(next)
    },
  })
  await worktrees.pickTarget('linked/feature')
  const opened = navigations.at(-1)!
  check(
    'a branch with a worktree opens its repository URL',
    opened.pathname === '/r/linked%20worktree%20%C3%A9',
  )
  check(
    'worktree navigation resets the previous revision and includes local work',
    !['base', 'target', 'commit', 'committed'].some((key) => opened.searchParams.has(key)) &&
      opened.hash === '',
  )
  check(
    'worktree navigation preserves display options and untracked scope',
    opened.searchParams.get('w') === '1' &&
      opened.searchParams.has('untracked') &&
      opened.searchParams.get('extra') === 'keep',
  )

  worktreeId = 'original'
  await worktrees.pickTarget('current/branch')
  check(
    'picking the current checkout branch enables its working tree without navigating',
    navigations.length === 1 &&
      worktrees.getSnapshot().target === null &&
      worktrees.getSnapshot().commit === null &&
      !worktrees.getSnapshot().committed &&
      worktreeUrl.searchParams.get('base') === 'release',
  )

  targetFail = true
  const beforeLookupFailure = worktrees.getSnapshot()
  let rejected = false
  await worktrees.pickTarget('broken').catch(() => {
    rejected = true
  })
  check(
    'failed worktree lookup leaves the current selection intact and reports the error',
    rejected && worktrees.getSnapshot() === beforeLookupFailure && navigations.length === 1,
  )
  targetFail = false

  worktreeId = 'another'
  let releaseTarget!: () => void
  targetDelay = new Promise<void>((resolve) => {
    releaseTarget = resolve
  })
  const pendingTarget = worktrees.pickTarget('slow')
  await worktrees.pickTarget(null)
  releaseTarget()
  await pendingTarget
  check('a late worktree lookup cannot undo a newer checkout selection', navigations.length === 1)

  targetDelay = new Promise<void>((resolve) => {
    releaseTarget = resolve
  })
  const beforeCommit = worktrees.pickTarget('slow')
  worktrees.pickCommit('new-commit')
  releaseTarget()
  await beforeCommit
  check(
    'a late worktree lookup cannot replace a newer commit selection',
    navigations.length === 1 && worktrees.getSnapshot().commit === 'new-commit',
  )

  targetDelay = new Promise<void>((resolve) => {
    releaseTarget = resolve
  })
  const beforeUnmount = worktrees.pickTarget('slow')
  worktrees.cancelPending()
  releaseTarget()
  await beforeUnmount
  check('leaving a worktree cancels its pending navigation', navigations.length === 1)
}
