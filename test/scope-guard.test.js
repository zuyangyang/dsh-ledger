import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const TOOLS_DIR = new URL('../lib/tools/', import.meta.url).pathname

/**
 * A tool that reads the journal directly bypasses the authorization seam, and
 * the failure is invisible: the query simply returns more rows than it should.
 * A test is the only place where "someone forgot" can be caught reliably.
 */
test('no tool reaches around the scoped view', () => {
  const offenders = []
  for (const name of readdirSync(TOOLS_DIR)) {
    if (!name.endsWith('.js')) continue
    const text = readFileSync(join(TOOLS_DIR, name), 'utf8')
    if (/\.store\.all\s*\(/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], 'these files read the journal directly; use runtime.view(exec).all()')
})

test('every tool writes through the view stamp', () => {
  const add = readFileSync(join(TOOLS_DIR, 'add.js'), 'utf8')
  assert.match(add, /view\.stamp\(\)/)
  assert.match(add, /ownerId: stamp\.ownerId/)
})
