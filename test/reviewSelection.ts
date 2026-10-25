import { createReviewSelection, releaseUrl } from '../web/src/reviewSelection.ts'
import type { Check } from './harness.ts'

export async function runReviewSelection(check: Check): Promise<void> {
  let url = new URL(
    'http://localhost/r/test?base=release&target=feature&commit=abc&committed&untracked&extra=keep#file',
  )
  const selection = createReviewSelection(url, {
    replaceUrl: (next) => {
      url = next
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
  selection.pickTarget('other/ref')
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
  selection.pickTarget(null)
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

  selection.pickBase('main')
  check(
    'a picked base is a URL parameter, for this review only',
    url.searchParams.get('base') === 'main' && selection.getSnapshot().query === '?base=main',
  )
  selection.pickBase(null)
  check(
    'the automatic base drops it',
    !url.searchParams.has('base') && selection.getSnapshot().query === '',
  )
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
  selection.pickTarget('other')
  selection.pickCommit('next')
  selection.toggleCommitted()
  selection.toggleUntracked()
  selection.pickBase('main')
  check(
    'changing revision and scope preserves whitespace filtering',
    selection.getSnapshot().ignoreWhitespace && url.searchParams.get('w') === '1',
  )
  const reloaded = createReviewSelection(url, {
    replaceUrl: () => {},
  })
  check('a reloaded URL restores the filter', reloaded.getSnapshot().ignoreWhitespace)
  selection.toggleWhitespace()
  check(
    'disabling whitespace filtering removes its URL parameter',
    !selection.getSnapshot().ignoreWhitespace && !url.searchParams.has('w'),
  )
  const disabled = createReviewSelection(new URL('http://localhost/r/test?w=0'), {
    replaceUrl: () => {},
  })
  check('w=0 keeps the full diff', !disabled.getSnapshot().ignoreWhitespace)

  selection.setActive(false)
  const beforeClose = url.href
  selection.pickBase('release')
  check('a closed review cannot replace the next tab URL', url.href === beforeClose)
  selection.setActive(true)
  selection.toggleCommitted()
  check(
    'StrictMode effect reactivation keeps selection controls functional',
    url.href !== beforeClose,
  )

  releaseUrl()
  const beforeSwitch = url.href
  selection.pickBase('release')
  check(
    'a review switched away from cannot replace the URL before it unmounts',
    url.href === beforeSwitch,
  )
}
