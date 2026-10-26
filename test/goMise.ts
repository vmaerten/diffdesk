import { findExecutable } from './system.ts'
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  archiveName,
  EXECUTABLE,
  miseReleaseFixture,
  sha256,
  type Release,
  type ReleaseAsset,
} from './miseReleaseFixture.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const published = args[0] === '--published'
assert.ok(
  args.length === 0 ||
    (published && (args.length === 2 || (args.length === 4 && args[2] === '--previous'))),
  'Usage: node test/goMise.ts [--published VERSION [--previous VERSION]]',
)
const requestedVersion = args[1]?.replace(/^v/, '')
const versionPattern = /^\d+\.\d+\.\d+(?:-[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*)?$/
if (published)
  assert.ok(requestedVersion && versionPattern.test(requestedVersion), 'Expected a release version')
if (args[3])
  assert.ok(versionPattern.test(args[3].replace(/^v/, '')), 'Expected a previous release version')
assert.equal(
  `${process.platform}-${process.arch}`,
  'darwin-arm64',
  'Diffdesk ships for macOS on Apple Silicon',
)
const miseBinary = realpathSync(process.env.DIFFDESK_TEST_MISE ?? findExecutable('mise'))
const miseVersion = execFileSync(miseBinary, ['--version'], { encoding: 'utf8' }).trim()
assert.match(
  miseVersion,
  /^2026\.10\.2 /,
  'Use mise 2026.10.2 for release acceptance (DIFFDESK_TEST_MISE can select it)',
)
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'diffdesk-mise-')))
const reportFile = join(root, '.task', published ? 'mise-published.json' : 'mise-acceptance.json')
const report = {
  complete: false,
  mode: published ? 'github-release' : 'local-release-fixture',
  mise: miseVersion,
  versions: [] as string[],
  checks: [] as string[],
  upgrade: false,
  latest: false,
  window: false,
}
mkdirSync(dirname(reportFile), { recursive: true })
const persistReport = () => writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
const record = (check: string) => {
  report.checks.push(check)
  persistReport()
  console.log(`mise: ${check}`)
}
persistReport()
const onlyGit = join(temporary, 'path')
mkdirSync(onlyGit)
symlinkSync(findExecutable('git'), join(onlyGit, 'git'))
symlinkSync(miseBinary, join(onlyGit, 'mise'))
const env: NodeJS.ProcessEnv = {
  PATH: `${onlyGit}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: process.env.HOME,
  MISE_DATA_DIR: join(temporary, 'data'),
  MISE_CONFIG_DIR: join(temporary, 'config'),
  MISE_CACHE_DIR: join(temporary, 'cache'),
  MISE_STATE_DIR: join(temporary, 'state'),
  MISE_SYSTEM_CONFIG_DIR: join(temporary, 'system'),
  MISE_GLOBAL_CONFIG_FILE: join(temporary, 'config', 'config.toml'),
  XDG_CONFIG_HOME: join(temporary, 'config'),
  XDG_DATA_HOME: join(temporary, 'data'),
  XDG_CACHE_HOME: join(temporary, 'cache'),
  XDG_STATE_HOME: join(temporary, 'state'),
  MISE_BIN: miseBinary,
  MISE_YES: '1',
  MISE_COLOR: '0',
  MISE_USE_VERSIONS_HOST: '0',
  MISE_HTTP_TIMEOUT: '15',
  MISE_NETRC: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  // Releases up to 0.2.0 are the browser CLI: should one start a daemon, it must
  // not be on the user's port.
  GHL_PORT: '0',
}
const execute = promisify(execFile)
const run = async (binary: string, argv: string[], overrides: NodeJS.ProcessEnv = {}) =>
  (
    await execute(binary, argv, {
      cwd: temporary,
      env: { ...env, ...overrides },
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    })
  ).stdout.trim()
const mise = (...argv: string[]) => run(miseBinary, argv)
const tool = 'github:vmaerten/ghl'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const github = async (path: string, accept = 'application/vnd.github+json') => {
  const response = await fetch(`https://api.github.com/repos/vmaerten/ghl/${path}`, {
    headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200, `GitHub ${path}: HTTP ${response.status}`)
  return response
}
const download = async (asset: ReleaseAsset) => {
  const url = new URL(asset.url)
  assert.equal(url.origin, 'https://api.github.com')
  assert.ok(url.pathname.startsWith('/repos/vmaerten/ghl/releases/assets/'))
  return Buffer.from(
    await (
      await github(url.pathname.replace('/repos/vmaerten/ghl/', ''), 'application/octet-stream')
    ).arrayBuffer(),
  )
}
/** Releases up to 0.2.0 shipped a browser CLI tarball instead of the app. */
const cliArchiveName = (version: string) => `ghl_${version}_darwin_arm64.tar.gz`
/** Releases up to 0.4 shipped the app as ghl.app, before it was renamed Diffdesk. */
const ghlArchiveName = (version: string) => `ghl_${version}_darwin_arm64.zip`
/** Where each kind of archive keeps its command, whose name mise puts on PATH. */
const executableIn = (archive: string, version: string) =>
  archive === archiveName(version)
    ? EXECUTABLE
    : archive === ghlArchiveName(version)
      ? 'ghl.app/Contents/MacOS/ghl'
      : 'ghl'
/** The install directory: the archive root, above the app when it is one. */
const installRoot = (binary: string, executable: string) =>
  binary.endsWith(`/${executable}`) ? binary.slice(0, -executable.length - 1) : dirname(binary)
const repo = join(temporary, 'review with spaces')
const statePath = join(repo, '.git/ghl/state.json')
let mirror: Awaited<ReturnType<typeof miseReleaseFixture>> | undefined
let window: string | undefined
const windowRunning = (binary: string) =>
  spawnSync('pgrep', ['-f', `${binary} --desktop-window`]).status === 0
try {
  assert.equal(
    await run('/bin/sh', [
      '-c',
      'for tool in node pnpm go; do if command -v "$tool" >/dev/null; then exit 1; fi; done',
    ]),
    '',
  )
  let current = '1.0.1'
  let previous: string | undefined = '1.0.0'
  const expected = new Map<
    string,
    { version: string; commit?: string; hash: string; app: boolean; executable: string }
  >()
  const commandOf = (version: string) => basename(expected.get(version)!.executable)
  if (published) {
    current = requestedVersion!
    if (token) env.GITHUB_TOKEN = token
    const releases: Release[] = await (await github('releases?per_page=100')).json()
    previous =
      args[3]?.replace(/^v/, '') ??
      releases
        .find((release) => {
          const version = release.tag_name.replace(/^v/, '')
          return (
            !release.draft &&
            !release.prerelease &&
            version !== current &&
            versionPattern.test(version) &&
            release.assets.some((asset) =>
              [archiveName(version), ghlArchiveName(version), cliArchiveName(version)].includes(
                asset.name,
              ),
            )
          )
        })
        ?.tag_name.replace(/^v/, '')
    for (const version of [current, ...(previous ? [previous] : [])]) {
      const release: Release = await (await github(`releases/tags/v${version}`)).json()
      assert.equal(release.draft, false)
      const archive = release.assets.find((asset) =>
        [archiveName(version), ghlArchiveName(version), cliArchiveName(version)].includes(
          asset.name,
        ),
      )
      const sums = release.assets.find((asset) => asset.name === 'checksums.txt')
      assert.ok(archive && sums, `Release v${version} lacks distribution assets`)
      const bytes = await download(archive)
      const checksum = (await download(sums))
        .toString()
        .split('\n')
        .find((line) => line.endsWith(`  ${archive.name}`))
        ?.split('  ')[0]
      assert.equal(sha256(bytes), checksum)
      if (archive.digest) assert.equal(archive.digest, `sha256:${checksum}`)
      const path = join(temporary, archive.name)
      writeFileSync(path, bytes)
      const app = archive.name.endsWith('.zip')
      const executable = executableIn(archive.name, version)
      const command = execFileSync(
        app ? 'unzip' : 'tar',
        app ? ['-p', path, executable] : ['-xOzf', path, executable],
        { maxBuffer: 64 * 1024 * 1024 },
      )
      expected.set(version, { version, hash: sha256(command), app, executable })
    }
    record('published archives match checksums.txt')
  } else {
    const dist = join(root, 'go/dist/release')
    const metadata = JSON.parse(readFileSync(join(dist, 'metadata.json'), 'utf8'))
    mirror = await miseReleaseFixture(temporary, join(dist, archiveName(metadata.version)))
    env.MISE_URL_REPLACEMENTS = JSON.stringify({
      'https://api.github.com/': `${mirror.origin}/`,
      'https://github.com/': `${mirror.origin}/`,
    })
    for (const version of [previous, current])
      expected.set(version, {
        version: metadata.version,
        commit: metadata.commit,
        hash: mirror.executables.get(version)!,
        app: true,
        executable: EXECUTABLE,
      })
  }
  report.versions = [current, ...(previous ? [previous] : [])]
  if (previous) assert.notEqual(previous, current, 'Upgrade needs two distinct release versions')
  const installed = new Map<string, string>()
  const verify = async (version: string) => {
    const want = expected.get(version)!
    const binary = realpathSync(
      await mise('which', '--tool', `${tool}@${version}`, commandOf(version)),
    )
    assert.ok(
      binary.startsWith(env.MISE_DATA_DIR + '/installs/'),
      'Executable must be installed in the isolated mise data directory',
    )
    if (want.app)
      assert.ok(binary.endsWith(`/${want.executable}`), 'mise must expose the app command')
    assert.equal(sha256(readFileSync(binary)), want.hash)
    const info = JSON.parse(await run(binary, ['--version', '--json'], { PATH: onlyGit }))
    assert.equal(info.version, want.version)
    if (want.commit) assert.equal(info.commit, want.commit)
    if (published && version === current && process.env.DIFFDESK_MISE_EXPECTED_COMMIT)
      assert.equal(info.commit, process.env.DIFFDESK_MISE_EXPECTED_COMMIT)
    assert.equal(
      await mise('exec', `${tool}@${version}`, '--', commandOf(version), '--version', '--json'),
      JSON.stringify(info),
    )
    const home = installRoot(binary, want.executable)
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.txt'])
      assert.ok(existsSync(join(home, file)), `${file} must ship with the install`)
    if (want.app) {
      const bundle = join(home, want.executable.split('/')[0]!)
      // Gatekeeper only stops a quarantined app; this one has no paid signature.
      assert.ok(
        !execFileSync('xattr', ['-lr', bundle], { encoding: 'utf8' }).includes(
          'com.apple.quarantine',
        ),
        'mise must not quarantine the app',
      )
      execFileSync('codesign', ['--verify', '--deep', '--strict', bundle])
    }
    installed.set(version, binary)
    return binary
  }
  const initial = previous ?? current
  await mise('use', '-g', `${tool}@${initial}`)
  const firstBinary = await verify(initial)
  // Activation puts the selected executable on PATH. Shims are an alternative.
  const activated = JSON.parse(
    await run('/bin/zsh', [
      '-f',
      '-c',
      `eval "$(mise activate zsh)"; eval "$(mise env -s zsh)"; ${commandOf(initial)} --version --json`,
    ]),
  )
  assert.equal(activated.version, expected.get(initial)?.version)
  // The selected version's shim: the command was ghl before the app became Diffdesk.
  let selected = initial
  const shim = () => join(env.MISE_DATA_DIR!, 'shims', commandOf(selected))
  assert.equal(JSON.parse(await run(shim(), ['--version', '--json'])).version, activated.version)
  record('clean install, archive autodetection, extraction, activation, shims and mise exec')

  mkdirSync(repo)
  const git = (...argv: string[]) =>
    execFileSync(join(onlyGit, 'git'), ['-C', repo, ...argv], { env, encoding: 'utf8' }).trim()
  git('init', '-b', 'main')
  git('config', 'user.name', 'mise fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'sample.txt'), 'after\n')
  git('commit', '-qam', 'review')
  mkdirSync(dirname(statePath))
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      viewed: {},
      comments: [
        {
          id: 'mise-preserved',
          path: 'sample.txt',
          side: 'additions',
          start: 1,
          end: 1,
          body: 'Keep this review across mise versions',
          anchor: ['after'],
          range: 'main..feature',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    }),
  )
  const stored = readFileSync(statePath, 'utf8')
  const exported = async () => {
    const { comments } = JSON.parse(
      await run(shim(), ['comments', '--json', '--repo', repo, '--base', 'main'], {
        PATH: onlyGit,
      }),
    ) as { comments: { id: string; body: string; code: string[] }[] }
    return comments.map(({ id, body, code }) => ({ id, body, code }))
  }
  const review = await exported()
  assert.deepEqual(review, [
    { id: 'mise-preserved', body: 'Keep this review across mise versions', code: ['after'] },
  ])
  const preserved = async () => {
    assert.deepEqual(await exported(), review)
    assert.equal(readFileSync(statePath, 'utf8'), stored)
  }
  record('the installed command exports review comments with only Git on PATH')

  const openWindow = async (binary: string) => {
    assert.ok(binary.includes('.app/Contents/MacOS/'), 'Only the app opens a window')
    // An empty probe keeps the app on an instance of its own, apart from the user's.
    const probe = join(temporary, 'probe.js')
    writeFileSync(probe, '')
    // Before launching: a launcher that fails may still have started the app.
    window = binary
    await run(shim(), ['--repo', repo, '--base', 'main'], {
      PATH: onlyGit,
      DIFFDESK_DESKTOP_PROBE: probe,
      // Releases up to 0.5.0 read the probe under the former name.
      GHL_DESKTOP_PROBE: probe,
    })
    for (let attempt = 0; attempt < 100 && !windowRunning(binary); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(windowRunning(binary), 'The app did not open its window from the mise install')
    spawnSync('pkill', ['-TERM', '-f', `${binary} --desktop-window`])
    for (let attempt = 0; attempt < 50 && windowRunning(binary); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(!windowRunning(binary), 'The app did not quit')
    window = undefined
    report.window = true
    record('the app opens its window from the mise install and quits')
  }
  if (expected.get(initial)?.app) await openWindow(firstBinary)

  if (previous) {
    if (mirror) {
      await mise('use', '-g', `${tool}@latest`)
      assert.equal(realpathSync(await mise('which', commandOf(previous))), firstBinary)
      mirror.publishNext()
      await mise('cache', 'clear')
      await mise('upgrade', '--no-prune', tool)
      report.latest = true
    } else await mise('upgrade', '--bump', '--no-prune', `${tool}@${current}`)
    selected = current
    const nextBinary = await verify(current)
    assert.equal(realpathSync(await mise('which', commandOf(current))), nextBinary)
    assert.ok(existsSync(firstBinary), 'Keep the previous version available for rollback')
    await preserved()
    if (!expected.get(initial)?.app && expected.get(current)?.app) await openWindow(nextBinary)
    record('upgrade keeps the previous install, and the review reads the same')
    await mise('use', '-g', `${tool}@${previous}`)
    await mise('upgrade', '--no-prune', tool)
    selected = previous
    assert.equal(
      realpathSync(await mise('which', commandOf(previous))),
      firstBinary,
      'An exact pin must survive upgrade',
    )
    await preserved()
    report.upgrade = true
    record('rollback and exact pin keep the review')
  } else record('first published version: historical upgrade/rollback awaits a second release')
  if (mirror) {
    // Exercise the exact-version upgrade command used by published mode too.
    await mise('upgrade', '--bump', '--no-prune', `${tool}@${current}`)
    assert.equal(realpathSync(await mise('which', commandOf(current))), await verify(current))
    await mise('use', '-g', `${tool}@${previous}`)
    selected = previous!
    await assert.rejects(() => mise('install', `${tool}@1.0.2`), /checksum|digest|mismatch/i)
    assert.equal(realpathSync(await mise('which', commandOf(previous!))), firstBinary)
    await preserved()
    assert.ok(mirror.requested.some((path) => path.endsWith('/checksums.txt')))
    assert.ok(mirror.requested.some((path) => path.endsWith(archiveName('1.0.1'))))
    const remote = await mise('ls-remote', tool)
    assert.ok(remote.includes('1.0.1'))
    assert.ok(!remote.includes('rc.1'), 'latest must exclude prereleases by default')
    record(
      'corrupt download rejected without altering selected version or review; prereleases excluded',
    )
  } else if (published && !current.includes('-')) {
    // The live gate validates this release immediately, before mise's default
    // minimum release age. Consumers can retain that delay or pin explicitly.
    await mise('use', '-g', '--minimum-release-age', '0s', `${tool}@latest`)
    assert.equal(
      realpathSync(await mise('which', commandOf(current))),
      realpathSync(await mise('which', '--tool', `${tool}@${current}`, commandOf(current))),
    )
    report.latest = true
    record('latest resolves the newly published stable release')
  }
  await mise('unuse', '-g', '--no-prune', tool)
  await mise('uninstall', '--all', tool)
  for (const binary of installed.values()) assert.equal(existsSync(binary), false)
  await assert.rejects(() => mise('which', commandOf(current)))
  assert.equal(readFileSync(statePath, 'utf8'), stored, 'Uninstall must preserve review data')
  report.complete = true
  record('uninstall removes selection and executables while preserving repository state')
} finally {
  if (window) spawnSync('pkill', ['-KILL', '-f', `${window} --desktop-window`])
  await mirror?.close()
  rmSync(temporary, { recursive: true, force: true })
}
