import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The release notes: the CHANGELOG.md section of the package.json version.
const { version }: { version: string } = JSON.parse(readFileSync('package.json', 'utf8'))
const section = readFileSync('CHANGELOG.md', 'utf8')
  .split(/^## /m)
  .find((part) => part.slice(0, part.indexOf('\n')).trim() === version)
assert.ok(section, `CHANGELOG.md has no "## ${version}" section`)
const notes = section.slice(section.indexOf('\n')).trim()
assert.ok(notes, `The CHANGELOG.md section for ${version} is empty`)
process.stdout.write(notes + '\n')
