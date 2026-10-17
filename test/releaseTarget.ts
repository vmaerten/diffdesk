export const RELEASE_TARGETS = [
  'darwin_arm64',
  'darwin_amd64',
  'linux_arm64',
  'linux_amd64',
] as const
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]

/** An override allows testing an Intel binary under Rosetta; reports retain the host. */
export function releaseTarget(): ReleaseTarget {
  const requested =
    process.env.GHL_TEST_TARGET ??
    `${process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`
  const target = RELEASE_TARGETS.find((supported) => supported === requested)
  if (!target) throw new Error(`Unsupported release test target: ${requested}`)
  return target
}

export function archiveName(version: string, target = releaseTarget()): string {
  return `ghl_${version}_${target}.tar.gz`
}
