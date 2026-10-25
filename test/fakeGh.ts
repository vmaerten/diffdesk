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
    // Nothing running: a pending check would poll during every suite on this branch.
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        workflowName: 'test',
        name: 'go',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/example/fixture/actions/runs/1',
      },
      {
        __typename: 'CheckRun',
        workflowName: 'test',
        name: 'ui',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        startedAt: '2026-10-25T10:00:00Z',
        completedAt: '2026-10-25T10:02:14Z',
        detailsUrl: 'https://github.com/example/fixture/actions/runs/2',
      },
      {
        __typename: 'StatusContext',
        context: 'deploy/netlify',
        state: 'SUCCESS',
        targetUrl: 'https://example.com/preview',
      },
    ],
  },
])

/**
 * A stand-in for gh, given to every test server so none reaches GitHub or the
 * developer's account. `stack/b` has an open pull request whose head is one
 * commit behind the branch, with one failing check; other branches have none.
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
