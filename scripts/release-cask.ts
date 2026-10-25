// Render the Homebrew cask for a published version from its checksums.txt.
// Usage: node scripts/release-cask.ts <version> <checksums.txt>
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const [version, checksums] = process.argv.slice(2)
assert.ok(version && checksums, 'Usage: node scripts/release-cask.ts <version> <checksums.txt>')
const archive = `diffdesk_${version}_darwin_arm64.zip`
const digest = readFileSync(checksums, 'utf8')
  .split('\n')
  .find((line) => line.endsWith(`  ${archive}`))
  ?.split('  ')[0]
assert.match(digest ?? '', /^[\da-f]{64}$/, `checksums.txt lacks ${archive}`)
const template = readFileSync(new URL('../desktop/cask.rb', import.meta.url), 'utf8')
process.stdout.write(template.replace('@VERSION@', version).replace('@SHA256@', digest!))
