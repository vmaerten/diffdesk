// Baseline: the real Node server, on a throwaway repository and an ephemeral port.
import { createGhlServer, listen, repoIdFor } from '../../src/server.ts'

const repoPath = process.env.BENCH_REPO!
const server = createGhlServer({ repos: [{ repoPath }], idleMs: 0 })
console.log(JSON.stringify({ port: await listen(server, 0), repoId: repoIdFor(repoPath) }))
