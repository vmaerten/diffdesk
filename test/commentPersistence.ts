import { createCommentPersistence, type CommentSubmission } from '../web/src/commentPersistence.ts'
import type { ServedComment } from '../src/types.ts'
import type { Check } from './harness.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const original: ServedComment = {
  id: 'one',
  path: 'file.ts',
  side: 'additions',
  start: 1,
  end: 1,
  body: 'original',
  range: 'main..feature',
  createdAt: '2026-09-20T00:00:00Z',
  anchor: ['old code'],
  code: ['old code'],
  stale: false,
}
const scope = { range: original.range, query: '?base=main&target=feature' }
const draft = (body: string, editing: string | null = 'one'): CommentSubmission => ({
  body,
  editing,
  path: original.path,
  side: original.side,
  start: original.start,
  end: original.end,
})

function setup() {
  const saves: ({ comment: ServedComment; query: string } & ReturnType<
    typeof deferred<ServedComment>
  >)[] = []
  const deletes: ({ id: string } & ReturnType<typeof deferred<void>>)[] = []
  const store = createCommentPersistence({
    save: (comment, query) => {
      const request = { comment, query, ...deferred<ServedComment>() }
      saves.push(request)
      return request.promise
    },
    remove: (id) => {
      const request = { id, ...deferred<void>() }
      deletes.push(request)
      return request.promise
    },
  })
  store.refresh()([original])
  return { store, saves, deletes }
}

export async function runCommentPersistence(check: Check): Promise<void> {
  {
    const methods: boolean[] = []
    const store = createCommentPersistence({
      save: async (comment, _query, editing) => {
        methods.push(editing)
        if (methods.length === 1) throw new Error('offline')
        return comment
      },
      remove: async () => {},
    })
    await store.submit(draft('new comment', null), scope)
    const id = store.getSnapshot().comments[0]!.id
    await store.submit(draft('revised after failure', id), scope)
    await store.submit(draft('edit after creation', id), scope)
    check(
      'editing a failed creation still creates before using PATCH',
      methods.join(',') === 'false,false,true',
    )
  }
  {
    const { store, saves } = setup()
    const save = store.submit(draft('edited'), scope)
    await Promise.resolve()
    const receive = store.refresh()
    receive([original])
    check(
      'refresh cannot replace an unsaved edit with the served copy of its ID',
      store.getSnapshot().comments[0]?.body === 'edited' &&
        store.getSnapshot().saving.get('one') === 'saving',
    )
    const staleRead = store.refresh()
    const confirmed = { ...saves[0]!.comment, anchor: ['server code'], code: ['server code'] }
    saves[0]!.resolve(confirmed)
    await save
    staleRead([original])
    check(
      'a read started before save completion cannot roll the edit back',
      store.getSnapshot().comments[0]?.body === 'edited',
    )
    check(
      'save responses supply server anchors, code and original creation time',
      store.getSnapshot().comments[0]?.code[0] === 'server code' &&
        store.getSnapshot().comments[0]?.createdAt === original.createdAt &&
        !store.getSnapshot().saving.has('one'),
    )
    store.refresh()([{ ...confirmed, code: ['changed again'], stale: true }])
    check(
      'a fresh read can enrich a confirmed comment again',
      store.getSnapshot().comments[0]?.stale === true &&
        store.getSnapshot().comments[0]?.code[0] === 'changed again',
    )
    const old = store.refresh()
    const newer = store.refresh()
    newer([])
    old([original])
    check(
      'late refreshes cannot restore another comparison',
      store.getSnapshot().comments.length === 0,
    )
  }
  {
    const { store, saves } = setup()
    const saving = store.submit(draft('new comment', null), scope)
    await Promise.resolve()
    const id = saves[0]!.comment.id
    saves[0]!.reject(new Error('offline'))
    await saving
    store.refresh()([])
    check(
      'failed new comments survive refresh with their text and retry state',
      store.getSnapshot().comments[0]?.body === 'new comment' &&
        store.getSnapshot().saving.get(id) === 'failed',
    )
    const retry = store.retry(id)
    await Promise.resolve()
    check(
      'retry retains its ID and original comparison after navigation',
      saves[1]?.comment.id === id &&
        saves[1]?.query === scope.query &&
        saves[1]?.comment.range === scope.range,
    )
    saves[1]!.resolve({ ...saves[1]!.comment, code: ['confirmed'] })
    await retry
    check(
      'successful retry clears the failure without duplicating the comment',
      store.getSnapshot().comments.length === 1 && store.getSnapshot().saving.size === 0,
    )
  }
  {
    const { store, saves } = setup()
    const first = store.submit(draft('first edit'), scope)
    const second = store.submit(draft('second edit'), scope)
    const independent = store.submit(draft('independent', 'two'), scope)
    await Promise.resolve()
    check(
      'writes to one ID serialize while other comments save independently',
      saves.length === 2 && saves[0]?.comment.id === 'one' && saves[1]?.comment.id === 'two',
    )
    saves[1]!.resolve(saves[1]!.comment)
    await independent
    saves[0]!.resolve(saves[0]!.comment)
    await first
    await Promise.resolve()
    check(
      'an older save response cannot replace the latest optimistic edit',
      store.getSnapshot().comments.find((c) => c.id === 'one')?.body === 'second edit' &&
        store.getSnapshot().saving.get('one') === 'saving',
    )
    check(
      'the latest edit reaches the server after its predecessor',
      saves[2]?.comment.body === 'second edit',
    )
    saves[2]!.resolve(saves[2]!.comment)
    await second
    check(
      'the last acknowledged edit is displayed',
      store.getSnapshot().comments.find((c) => c.id === 'one')?.body === 'second edit' &&
        store.getSnapshot().saving.size === 0,
    )
  }
  {
    const { store, saves, deletes } = setup()
    const saving = store.submit(draft('edited before delete'), scope)
    const removing = store.remove('one')
    await Promise.resolve()
    store.refresh()([original])
    check(
      'optimistic deletion stays hidden across refresh and waits for the save',
      store.getSnapshot().comments.length === 0 && deletes.length === 0,
    )
    saves[0]!.resolve(saves[0]!.comment)
    await saving
    await Promise.resolve()
    const staleRead = store.refresh()
    check(
      'delete reaches the server after the pending save',
      deletes[0]?.id === 'one' && store.getSnapshot().comments.length === 0,
    )
    deletes[0]!.resolve()
    await removing
    staleRead([original])
    check(
      'a late read cannot resurrect a confirmed deletion',
      store.getSnapshot().comments.length === 0,
    )
    store.refresh()([])
    check(
      'a fresh read confirms the deletion',
      store.getSnapshot().comments.length === 0 && store.getSnapshot().saving.size === 0,
    )
  }
  {
    const { store, saves, deletes } = setup()
    const saving = store.submit(draft('keep this sentence'), scope)
    const removing = store.remove('one')
    const deletionFailure = removing.catch((error: unknown) => error)
    await Promise.resolve()
    saves[0]!.reject(new Error('save failed'))
    await saving
    await Promise.resolve()
    deletes[0]!.reject(new Error('delete failed'))
    check('delete failure reaches the caller', (await deletionFailure) instanceof Error)
    check(
      'failed deletion restores the pending text and its save failure',
      store.getSnapshot().comments[0]?.body === 'keep this sentence' &&
        store.getSnapshot().saving.get('one') === 'failed',
    )
    const retry = store.retry('one')
    await Promise.resolve()
    check(
      'restored pending text retries against its original scope',
      saves[1]?.query === scope.query,
    )
    saves[1]!.resolve(saves[1]!.comment)
    await retry
  }
}
