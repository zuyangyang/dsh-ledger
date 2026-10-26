import assert from 'node:assert/strict'
import test from 'node:test'

import { KINDS, isLive, openMinor, validateStoredRecord } from '../lib/events.js'
import { deriveDedupeKey, deriveRequestId, newTxId } from '../lib/ids.js'

const base = {
  id: 'tx_1', version: 1, kind: 'expense', status: 'confirmed', book: 'home',
  amount_minor: 3200, occurred_on: '2026-10-25',
}

test('a well-formed record validates', () => {
  assert.equal(validateStoredRecord(base).ok, true)
})

test('every bad line is rejected with a reason', () => {
  assert.equal(validateStoredRecord(null).reason, 'not-an-object')
  assert.equal(validateStoredRecord({ ...base, id: '' }).reason, 'missing-id')
  assert.equal(validateStoredRecord({ ...base, version: 0 }).reason, 'bad-version')
  assert.equal(validateStoredRecord({ ...base, kind: 'gift' }).reason, 'bad-kind')
  assert.equal(validateStoredRecord({ ...base, book: 'mall' }).reason, 'bad-book')
  assert.equal(validateStoredRecord({ ...base, status: 'done' }).reason, 'bad-status')
  assert.equal(validateStoredRecord({ ...base, amount_minor: 12.5 }).reason, 'bad-amount')
  assert.equal(validateStoredRecord({ ...base, occurred_on: '2026/10/25' }).reason, 'bad-date')
})

test('only confirmed records are live', () => {
  assert.equal(isLive(base), true)
  assert.equal(isLive({ ...base, status: 'draft' }), false)
  assert.equal(isLive({ ...base, status: 'void' }), false)
})

test('a credit sale exposes its open amount', () => {
  const sale = { ...base, kind: 'sale', book: 'shop', amount_minor: 50000, paid_minor: 0 }
  assert.equal(openMinor(sale), 50000)
  assert.equal(openMinor(sale, 20000), 30000)
  assert.equal(openMinor({ ...base, amount_minor: 10000, paid_minor: 10000 }), 0)
})

test('ids are sortable, prefixed and unique', () => {
  const a = newTxId(new Date('2026-10-25T00:00:00Z'))
  const b = newTxId(new Date('2026-10-26T00:00:00Z'))
  assert.match(a, /^tx_[0-9a-z]+$/)
  assert.ok(a < b)
  assert.notEqual(newTxId(), newTxId())
})

test('request ids are stable for the same message and item', () => {
  const args = { sessionId: 's', messageId: 'm', toolName: 'ledger_add', itemIndex: 0, payloadHash: 'h' }
  assert.equal(deriveRequestId(args), deriveRequestId({ ...args }))
  assert.notEqual(deriveRequestId(args), deriveRequestId({ ...args, itemIndex: 1 }))
})

test('dedupe keys group identical money on the same day', () => {
  const key = { kind: 'expense', amountMinor: 3200, occurredOn: '2026-10-25', merchant: null, customer: null, note: '午饭' }
  assert.equal(deriveDedupeKey(key), deriveDedupeKey({ ...key, note: ' 午饭 ' }))
  assert.notEqual(deriveDedupeKey(key), deriveDedupeKey({ ...key, amountMinor: 3201 }))
})

test('kinds cover home and shop', () => {
  assert.ok(KINDS.includes('expense'))
  assert.ok(KINDS.includes('sale'))
  assert.ok(KINDS.includes('payment_in'))
})
