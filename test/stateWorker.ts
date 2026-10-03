// A separate Node writer used by the cross-process state contract tests.
import { writeFile } from 'node:fs/promises'

import { gitDirPath } from '../src/git.ts'
import { putComment, removeComment, setViewed } from '../src/state.ts'
import { withStateLock } from '../src/stateLock.ts'
import type { Comment } from '../src/types.ts'

const [repo, worker, action] = process.argv.slice(2)
if (!repo || !worker) throw new Error('repo and worker are required')
if (action === 'crash') {
  await withStateLock(repo, async () => {
    await writeFile((await gitDirPath(repo, 'ghl/state.json')) + '.interrupted.tmp', '{')
    console.log('ready')
    await new Promise(() => {})
  })
} else {
  for (let i = 0; i < 10; i++) {
    const comment: Comment = {
      id: `${worker}-${i}`,
      path: 'context.txt',
      side: 'additions',
      start: 1,
      end: 1,
      anchor: ['new'],
      body: worker,
      range: 'main..feature',
      createdAt: '2020-01-01T00:00:00.000Z',
    }
    await putComment(repo, comment)
    await setViewed(repo, {
      range: 'concurrent',
      path: `${worker}-${i}`,
      hash: worker,
      viewed: true,
    })
    await putComment(repo, { ...comment, id: 'seed', createdAt: 'later' })
  }
  await removeComment(repo, `delete-${worker}`)
}
