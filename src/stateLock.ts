import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

/** Same worktree-private prepared transaction as Go's state_lock.go. */
export async function withStateLock<T>(repoPath: string, work: () => Promise<T>): Promise<T> {
  const release = await acquire(repoPath)
  try {
    return await work()
  } finally {
    await release()
  }
}

async function acquire(repoPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const child = spawn(
      'git',
      [
        '-C',
        repoPath,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.filesRefLockTimeout=0',
        'update-ref',
        '--stdin',
        '--no-deref',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      },
    )
    let output = ''
    let errors = ''
    child.stderr.on('data', (chunk) => {
      errors += String(chunk).slice(0, 65536 - errors.length)
    })
    const exited = once(child, 'close')
    let ready!: () => void
    const prepared = new Promise<void>((resolve) => {
      ready = resolve
    })
    child.stdout.on('data', (chunk) => {
      output += String(chunk).slice(0, 1024 - output.length)
      if (output === 'start: ok\nprepare: ok\n') ready()
    })
    child.stdin.on('error', () => {}) // A contended transaction exits early.
    child.stdin.write('start\nverify refs/worktree/ghl-state-lock\nprepare\n')
    const release = async () => {
      // EOF aborts even when the parent dies. No reference is committed.
      child.stdin.end()
      const [code] = await exited
      if (code !== 0) throw new Error(`State lock: ${errors.trim() || output.trim()}`)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let locked: boolean
    try {
      locked = await Promise.race([
        prepared.then(() => true),
        exited.then(() => false),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out preparing the state lock')), 10_000)
        }),
      ])
    } catch (error) {
      child.stdin.end()
      await exited.catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (locked) return release
    child.stdin.end()
    await exited
    if (!errors.includes('File exists') && !errors.includes('another git process')) {
      throw new Error(`State lock: ${errors.trim() || output.trim()}`)
    }
    if (Date.now() >= deadline)
      throw new Error('State is busy; retry after the other writer finishes')
    await delay(20)
  }
}
