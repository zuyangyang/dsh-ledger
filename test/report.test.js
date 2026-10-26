import assert from 'node:assert/strict'
import test from 'node:test'

import { renderDayReport, renderMonthReport, summarizeDay, summarizeMonth, summarizeShopCash } from '../lib/views/report.js'

let seq = 0
function rec(overrides = {}) {
  seq += 1
  return {
    id: 'rx_' + String(seq).padStart(4, '0'),
    schema: 2,
    version: 1,
    kind: 'expense',
    status: 'confirmed',
    book: 'home',
    amount_minor: 3200,
    paid_minor: 3200,
    currency: 'CNY',
    occurred_on: '2026-10-26',
    created_at: '2026-10-26T12:00:00+08:00',
    category: { l1: 'food', l2: null },
    note: '午饭',
    ...overrides,
  }
}

test('a day report adds expenses and ignores transfers', () => {
  const records = [
    rec({ amount_minor: 3200 }),
    rec({ amount_minor: 1800, category: { l1: 'transport', l2: null }, note: '打车' }),
    rec({ kind: 'transfer', amount_minor: 50000, category: { l1: 'other', l2: null } }),
  ]
  const summary = summarizeDay(records, { date: '2026-10-26' })
  assert.equal(summary.expense_minor, 5000)
  assert.equal(summary.count, 3)
  assert.equal(summary.byCategory.length, 2)
})

test('a refund reduces spending without becoming income', () => {
  const records = [
    rec({ amount_minor: 10000, category: { l1: 'shopping', l2: null } }),
    rec({ kind: 'refund', amount_minor: 4000, category: { l1: 'shopping', l2: null } }),
  ]
  const summary = summarizeDay(records, { date: '2026-10-26' })
  assert.equal(summary.expense_minor, 10000)
  assert.equal(summary.refund_minor, 4000)
  assert.equal(summary.income_minor, 0)
  assert.equal(summary.byCategory[0].amount_minor, 10000)
})

test('category shares are integer basis points summing to 100%', () => {
  const records = [
    rec({ amount_minor: 3333, category: { l1: 'food', l2: null } }),
    rec({ amount_minor: 3333, category: { l1: 'transport', l2: null } }),
    rec({ amount_minor: 3334, category: { l1: 'housing', l2: null } }),
  ]
  const summary = summarizeDay(records, { date: '2026-10-26' })
  const total = summary.byCategory.reduce((sum, row) => sum + row.share_bp, 0)
  assert.equal(total, 10000)
})

test('a month report groups by day and lists the biggest entries', () => {
  const records = [
    rec({ amount_minor: 3200, occurred_on: '2026-10-01' }),
    rec({ amount_minor: 9900, occurred_on: '2026-10-02', category: { l1: 'housing', l2: null } }),
    rec({ amount_minor: 1000, occurred_on: '2026-10-02' }),
    rec({ amount_minor: 500, occurred_on: '2026-11-01' }),
  ]
  const summary = summarizeMonth(records, { month: '2026-10', book: 'home' })
  assert.equal(summary.count, 3)
  assert.equal(summary.expense_minor, 14100)
  assert.equal(summary.byDay.length, 2)
  assert.equal(summary.byDay[1].expense_minor, 10900)
  assert.equal(summary.biggest[0].amount_minor, 9900)
})

test('drafts and voids stay out of every total', () => {
  const records = [rec({ status: 'draft' }), rec({ status: 'void' }), rec({ amount_minor: 100 })]
  assert.equal(summarizeMonth(records, { month: '2026-10' }).expense_minor, 100)
})

test('shop cash counts only money that actually moved', () => {
  const records = [
    rec({ book: 'shop', kind: 'sale', amount_minor: 50000, paid_minor: 20000, customer: '老陈', channel: 'retail', category: { l1: 'biz_revenue', l2: null } }),
    rec({ book: 'shop', kind: 'sale', amount_minor: 30000, paid_minor: 30000, customer: '老李', channel: 'wholesale', category: { l1: 'biz_revenue', l2: null } }),
    rec({ book: 'shop', kind: 'purchase', amount_minor: 40000, paid_minor: 10000, category: null }),
    rec({ book: 'shop', kind: 'expense', amount_minor: 4000, paid_minor: 4000, category: { l1: 'biz_utilities', l2: null } }),
  ]
  const summary = summarizeShopCash(records, { month: '2026-10' })
  assert.equal(summary.sales_minor, 80000)
  assert.equal(summary.retail_minor, 50000)
  assert.equal(summary.wholesale_minor, 30000)
  assert.equal(summary.cash_in_minor, 50000)
  assert.equal(summary.cash_out_minor, 14000)
  assert.equal(summary.cash_net_minor, 36000)
  assert.equal(summary.receivable_open_minor, 30000)
})

test('payment_in is cash in, never revenue', () => {
  const records = [
    rec({ book: 'shop', kind: 'sale', amount_minor: 10000, paid_minor: 0, customer: '老陈', category: { l1: 'biz_revenue', l2: null } }),
    rec({ book: 'shop', kind: 'payment_in', amount_minor: 6000, customer: '老陈', occurred_on: '2026-10-27', created_at: '2026-10-27T09:00:00+08:00', category: { l1: 'biz_cashflow', l2: null } }),
  ]
  const summary = summarizeShopCash(records, { month: '2026-10' })
  assert.equal(summary.sales_minor, 10000)
  assert.equal(summary.cash_in_minor, 6000)
  assert.equal(summary.receivable_open_minor, 4000)
})

test('the day report renders a table and never mentions a budget', () => {
  const summary = summarizeDay([rec({ amount_minor: 3200 }), rec({ amount_minor: 1800, category: { l1: 'transport', l2: null } })], { date: '2026-10-26' })
  const text = renderDayReport(summary)
  assert.match(text, /2026-10-26/)
  assert.match(text, /餐饮/)
  assert.match(text, /¥50\.00/)
  assert.doesNotMatch(text, /预算/)
})

test('an empty month says so plainly', () => {
  const text = renderMonthReport(summarizeMonth([], { month: '2026-12' }))
  assert.match(text, /没有记录/)
})
