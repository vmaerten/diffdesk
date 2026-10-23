import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  url: string
  digest: string | null
}

export interface Release {
  tag_name: string
  draft: boolean
  prerelease: boolean
  created_at: string
  assets: ReleaseAsset[]
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export const archiveName = (version: string) => `ghl_${version}_darwin_arm64.zip`

/** Where the command lives in the archive, which is where mise puts it on PATH. */
export const EXECUTABLE = 'ghl.app/Contents/MacOS/ghl'

/** Real mise client/backend, local release API; no tags or releases are created. */
export async function miseReleaseFixture(directory: string, archive: string) {
  const candidate = readFileSync(archive)
  const extracted = join(directory, 'candidate')
  execFileSync('ditto', ['-x', '-k', archive, extracted])
  // A distinct predecessor that still runs: the same build with another bundle
  // marker, signed again. This is not a historical release test.
  const predecessor = join(directory, 'predecessor')
  cpSync(extracted, predecessor, { recursive: true })
  execFileSync('plutil', [
    '-insert',
    'GHLFixture',
    '-string',
    'predecessor',
    join(predecessor, 'ghl.app/Contents/Info.plist'),
  ])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(predecessor, 'ghl.app')])
  const predecessorArchive = join(directory, 'predecessor.zip')
  execFileSync(
    'zip',
    ['-qry', predecessorArchive, 'ghl.app', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'],
    {
      cwd: predecessor,
    },
  )
  const executables = new Map<string, string>()
  const assets = new Map<string, Buffer>()
  const releases: Release[] = []
  const requested: string[] = []
  let available = ['v1.0.0']
  const add = (version: string, from: string, bytes: Buffer, corrupt = false) => {
    executables.set(version, sha256(readFileSync(join(from, EXECUTABLE))))
    const name = archiveName(version)
    const digest = corrupt ? '0'.repeat(64) : sha256(bytes)
    const release: Release = {
      tag_name: `v${version}`,
      draft: false,
      prerelease: version.includes('-'),
      created_at: '2026-09-01T00:00:00Z',
      assets: [],
    }
    for (const [filename, payload] of [
      [name, bytes],
      ['checksums.txt', Buffer.from(`${digest}  ${name}\n`)],
    ] as [string, Buffer][]) {
      const download = `/vmaerten/ghl/releases/download/v${version}/${filename}`
      const api = `/repos/vmaerten/ghl/releases/assets/${assets.size + 1}`
      assets.set(download, payload)
      assets.set(api, payload)
      release.assets.push({
        name: filename,
        browser_download_url: `https://github.com${download}`,
        url: `https://api.github.com${api}`,
        // Exercise the published checksum file fallback for the predecessor.
        digest:
          from === predecessor ? null : `sha256:${filename === name ? digest : sha256(payload)}`,
      })
    }
    releases.push(release)
  }
  add('1.0.0', predecessor, readFileSync(predecessorArchive))
  add('1.0.1', extracted, candidate)
  add('1.1.0-rc.1', extracted, candidate)
  add('1.0.2', extracted, candidate, true)
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
    requested.push(path)
    const payload = assets.get(path)
    if (payload) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(payload)
      return
    }
    let result: unknown
    if (path === '/repos/vmaerten/ghl/releases')
      result = available.map((tag) => releases.find((release) => release.tag_name === tag))
    if (path === '/repos/vmaerten/ghl/releases/latest')
      result = releases.find(
        (release) => release.tag_name === available.find((tag) => !tag.includes('-')),
      )
    if (path.startsWith('/repos/vmaerten/ghl/releases/tags/'))
      result = releases.find(
        (release) => release.tag_name === decodeURIComponent(path.split('/').at(-1) ?? ''),
      )
    response.writeHead(result ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(result ?? { message: 'Not Found' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requested,
    /** The executable each version installs, as a SHA-256. */
    executables,
    publishNext: () => {
      available = ['v1.1.0-rc.1', 'v1.0.1', 'v1.0.0']
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
