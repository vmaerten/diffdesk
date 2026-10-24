import assert from 'node:assert/strict'

import { runImages } from './images.ts'

let checks = 0
await runImages((name, ok, detail) => {
  assert.ok(ok, `${name}: ${detail ?? ''}`)
  checks++
  console.log(`  ok ${name}`)
})
console.log(`  ok ${checks} Go image API and browser checks`)
