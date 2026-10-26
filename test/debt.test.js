import assert from 'node:assert/strict'
import test from 'node:test'

import { bucketOf, summarizeDebt } from '../lib/views/debt.js'

let seq = 0
function rec(overrides = {}) {
  seq += 1
  return {
    id: 'tx_' + String(seq).padStart(4, '0'),
    schema: 2,
    version: 1,
    kind: 'sale',
    status: 'confirmed',
    book: 'shop',
    amount_minor: 10000,
    paid_minor: 0,
    currency: 'CNY',
    occurred_on: '2026-10-01',
    created_at: '2026-10-01T09:00:00+08:00',
    customer: '老陈',
    category: { l1: 'biz_revenue', l2: null },
    note: '',
    ...overrides,
  }
}

test('an unpaid sale becomes a receivable', () => {
  const summary = summarizeDebt([rec({ amount_minor: 68000 })], { asOf: '2026-10-20' })
  assert.equal(summary.total_minor, 68000)
  assert.equal(summary.people.length, 1)
  assert.equal(summary.people[0].name, '老陈')
  assert.equal(summary.people[0].age_days, 19)
  assert.equal(summary.people[0].bucket, 'd0_30')
})

test('a fully paid sale is not a receivable', () => {
  const summary = summarizeDebt([rec({ amount_minor: 68000, paid_minor: 68000 })], { asOf: '2026-10-20' })
  assert.equal(summary.total_minor, 0)
  assert.equal(summary.people.length, 0)
})

test('payments are allocated FIFO to the oldest sale', () => {
  const records = [
    rec({ amount_minor: 10000, occurred_on: '2026-09-01', created_at: '2026-09-01T09:00:00+08:00' }),
    rec({ amount_minor: 20000, occurred_on: '2026-09-10', created_at: '2026-09-10T09:00:00+08:00' }),
    rec({ kind: 'payment_in', amount_minor: 15000, paid_minor: null, occurred_on: '2026-09-20', created_at: '2026-09-20T09:00:00+08:00' }),
  ]
  const summary = summarizeDebt(records, { asOf: '2026-10-01' })
  assert.equal(summary.total_minor, 15000)
  // The first sale is clear, the second one carries 5000 of the payment.
  assert.equal(summary.people[0].oldest_on, '2026-09-10')
  assert.equal(summary.people[0].items, 1)
})

test('a payment larger than the debt is dropped, never negative', () => {
  const records = [
    rec({ amount_minor: 10000 }),
    rec({ kind: 'payment_in', amount_minor: 30000, occurred_on: '2026-10-05', created_at: '2026-10-05T09:00:00+08:00' }),
  ]
  const summary = summarizeDebt(records, { asOf: '2026-10-20' })
  assert.equal(summary.total_minor, 0)
})

test('a return offsets the oldest open sale for that customer', () => {
  const records = [
    rec({ amount_minor: 10000 }),
    rec({ kind: 'return', amount_minor: 4000, occurred_on: '2026-10-05', created_at: '2026-10-05T09:00:00+08:00' }),
  ]
  assert.equal(summarizeDebt(records, { asOf: '2026-10-20' }).total_minor, 6000)
})

test('scattered customers are kept out of the per-person table', () => {
  const records = [rec({ amount_minor: 5000, customer: '散客' }), rec({ amount_minor: 7000, customer: '老李' })]
  const summary = summarizeDebt(records, { asOf: '2026-10-20' })
  assert.equal(summary.total_minor, 7000)
  assert.equal(summary.scattered_minor, 5000)
  assert.deepEqual(summary.people.map((person) => person.name), ['老李'])
})

test('aging buckets follow the oldest open item', () => {
  assert.equal(bucketOf(0), 'd0_30')
  assert.equal(bucketOf(30), 'd0_30')
  assert.equal(bucketOf(31), 'd31_60')
  assert.equal(bucketOf(90), 'd61_90')
  assert.equal(bucketOf(91), 'd90p')
  const records = [
    rec({ amount_minor: 1000, occurred_on: '2026-06-01', created_at: '2026-06-01T09:00:00+08:00' }),
    rec({ amount_minor: 2000, occurred_on: '2026-10-01', created_at: '2026-10-01T09:00:00+08:00' }),
  ]
  const summary = summarizeDebt(records, { asOf: '2026-10-26' })
  assert.equal(summary.people[0].bucket, 'd90p')
  assert.equal(summary.buckets.d90p, 1000)
  assert.equal(summary.buckets.d0_30, 2000)
})

test('payables use purchases and outgoing payments', () => {
  const records = [
    rec({ kind: 'purchase', amount_minor: 90000, paid_minor: 40000, customer: null, supplier: '厂家A', category: null }),
    rec({ kind: 'payment_out', amount_minor: 20000, occurred_on: '2026-10-10', created_at: '2026-10-10T09:00:00+08:00', supplier: '厂家A' }),
  ]
  const summary = summarizeDebt(records, { side: 'payable', asOf: '2026-10-20' })
  assert.equal(summary.title, '我欠外面')
  assert.equal(summary.people[0].name, '厂家A')
  assert.equal(summary.total_minor, 30000)
})

test('drafts and voids never count', () => {
  const records = [rec({ status: 'draft' }), rec({ status: 'void' })]
  assert.equal(summarizeDebt(records, { asOf: '2026-10-20' }).total_minor, 0)
})

test('asOf cuts off later entries', () => {
  const records = [rec({ occurred_on: '2026-10-25', created_at: '2026-10-25T09:00:00+08:00' })]
  assert.equal(summarizeDebt(records, { asOf: '2026-10-20' }).total_minor, 0)
  assert.equal(summarizeDebt(records, { asOf: '2026-10-25' }).total_minor, 10000)
})

test('the report flags people over 30 days and always shows the last entry', () => {
  const records = [
    rec({ amount_minor: 10000, occurred_on: '2026-08-01', created_at: '2026-08-01T09:00:00+08:00' }),
    rec({ kind: 'sale', amount_minor: 5000, occurred_on: '2026-10-20', created_at: '2026-10-20T09:00:00+08:00' }),
  ]
  const summary = summarizeDebt(records, { asOf: '2026-10-26' })
  assert.match(summary.people[0].last.occurred_on, /2026-10-20/)
  assert.equal(summary.people[0].age_days, 86)
})
