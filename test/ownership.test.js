import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_OWNER, appendOwnership, loadOwnership, ownerOf, ownershipPath } from '../lib/ownership.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'ledger-owner-'))

test('a missing side table is empty, not an error', () => {
  assert.equal(loadOwnership(tempDir()).size, 0)
})

test('ownership facts append and fold last-wins', () => {
  const dir = tempDir()
  appendOwnership(dir, [{ recordId: 'r1', ownerId: 'u_a' }])
  appendOwnership(dir, [{ recordId: 'r1', ownerId: 'u_b' }, { recordId: 'r2', ownerId: 'u_a' }])
  const owners = loadOwnership(dir)
  assert.equal(owners.get('r1'), 'u_b')
  assert.equal(owners.get('r2'), 'u_a')
  assert.equal(appendOwnership(dir, []), 0)
})

test('a torn trailing line is skipped', () => {
  const dir = tempDir()
  appendOwnership(dir, [{ recordId: 'r1', ownerId: 'u_a' }])
  appendFileSync(ownershipPath(dir), '{"recordId":"r2","ownerId":', 'utf8')
  assert.deepEqual([...loadOwnership(dir).keys()], ['r1'])
})

test('appendOwnership records the journal alongside it', () => {
  const dir = tempDir()
  appendOwnership(dir, [{ recordId: 'r1', ownerId: 'u_a', reason: 'claim' }])
  const line = readFileSync(ownershipPath(dir), 'utf8').trim()
  assert.equal(JSON.parse(line).reason, 'claim')
})

test('an unowned record falls back to the shared bucket', () => {
  assert.equal(ownerOf({ id: 'r1' }, new Map()), DEFAULT_OWNER)
  assert.equal(ownerOf(null, new Map()), DEFAULT_OWNER)
  assert.equal(ownerOf({ id: 'r1', ownerId: '' }, new Map([['r1', 'u_a']])), 'u_a')
})
