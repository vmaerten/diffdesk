import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PULL_REQUEST = JSON.stringify([
  {
    number: 42,
    title: 'Top layer',
    url: 'https://github.com/example/fixture/pull/42',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'alice' },
    baseRefName: 'stack/a',
    headRefOid: 'HEAD_OID',
    reviewDecision: 'APPROVED',
    mergeable: 'MERGEABLE',
    reviewRequests: [],
    latestReviews: [{ author: { login: 'bob' }, state: 'APPROVED' }],
  },
])

/**
 * A stand-in for gh, given to every test server so none reaches GitHub or the
 * developer's account. `stack/b` has an open pull request whose head is one
 * commit behind the branch; other branches have none.
 */
export const fakeGh = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'ghl-fake-gh-'))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'gh')
  const [before, after] = PULL_REQUEST.split('HEAD_OID')
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
'api user'*) echo fixture ;;
*'--head stack/b '*) printf '%s%s%s\\n' '${before}' "$(git rev-parse stack/a)" '${after}' ;;
*) echo '[]' ;;
esac
`,
    { mode: 0o700 },
  )
  return path
})()
