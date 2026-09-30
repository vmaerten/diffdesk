// Throwaway benchmark: deliberately only GET, with one connection per request.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
/** @param {string} name */
function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const server = createServer(async (req, res) => {
  try {
    let body
    if (req.url === '/health') body = Buffer.from('{"ok":true}\n')
    else if (req.url === '/') body = await readFile(required('BENCH_INDEX'))
    else if (req.url === '/asset') body = await readFile(required('BENCH_ASSET'))
    else if (req.url === '/diff') {
      const result = await exec(
        'git',
        ['-C', required('BENCH_REPO'), 'diff', '--no-ext-diff', '--no-color', 'HEAD'],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      )
      body = result.stdout
    } else throw new Error('unknown route')
    res.writeHead(200, { 'Content-Length': body.length, Connection: 'close' })
    res.end(body)
  } catch (error) {
    res.writeHead(500, { Connection: 'close' })
    res.end(String(error))
  }
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address && typeof address !== 'string') console.log(address.port)
})
