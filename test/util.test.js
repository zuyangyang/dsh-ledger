import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareRecords, divRoundHalfUp, expandHome, formatMinor, formatMoney,
  shanghaiDate, shanghaiHour, shanghaiIso, stableKey,
} from '../lib/util.js'

test('expandHome leaves absolute paths alone', () => {
  assert.equal(expandHome('/tmp/x'), '/tmp/x')
})

test('expandHome expands a bare tilde', () => {
  assert.ok(expandHome('~').startsWith('/'))
  assert.equal(expandHome('~/a/b').endsWith('/a/b'), true)
})

test('divRoundHalfUp rounds halves away from zero', () => {
  assert.equal(divRoundHalfUp(5, 2), 3)
  assert.equal(divRoundHalfUp(4, 2), 2)
  assert.equal(divRoundHalfUp(-5, 2), -3)
  assert.equal(divRoundHalfUp(1, 0), 0)
})

test('formatMoney keeps two decimals and the sign outside the symbol', () => {
  assert.equal(formatMinor(3200), '32.00')
  assert.equal(formatMinor(5), '0.05')
  assert.equal(formatMinor(-1200), '-12.00')
  assert.equal(formatMoney(3200), '¥32.00')
  assert.equal(formatMoney(-1200), '-¥12.00')
})

test('shanghai helpers read the fixed +08:00 wall clock', () => {
  const d = new Date('2026-10-25T18:30:00.000Z')
  assert.equal(shanghaiIso(d), '2026-10-26T02:30:00+08:00')
  assert.equal(shanghaiDate(d), '2026-10-26')
  assert.equal(shanghaiHour(d), 2)
})

test('compareRecords is the one true total order', () => {
  const rows = [
    { id: 'b', occurred_on: '2026-10-01', created_at: '2026-10-01T10:00:00+08:00' },
    { id: 'a', occurred_on: '2026-10-01', created_at: '2026-10-01T09:00:00+08:00' },
    { id: 'c', occurred_on: '2026-09-30', created_at: '2026-10-01T11:00:00+08:00' },
  ]
  const sorted = [...rows].sort(compareRecords).map((r) => r.id)
  assert.deepEqual(sorted, ['c', 'a', 'b'])
})

test('stableKey normalizes case and trims', () => {
  assert.equal(stableKey('  Coffee '), 'coffee')
  assert.equal(stableKey(null), '')
})
