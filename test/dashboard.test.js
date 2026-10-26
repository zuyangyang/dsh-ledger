import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDashboard, monthRange, resolveMonth, shiftMonth } from '../lib/dashboard.js'
import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig({})

function record(overrides) {
  return {
    id: 'tx_' + Math.random().toString(36).slice(2, 10),
    schema: 2, version: 1, kind: 'expense', status: 'confirmed', book: 'home',
    amount_minor: 3200, currency: 'CNY', occurred_on: '2026-10-05',
    paid_minor: 3200, category: { l1: 'food', l2: null, source: 'builtin' },
    merchant: null, customer: null, supplier: null, channel: null,
    entered_by: 'yang', created_at: '2026-10-05T12:00:00+08:00',
    note: '', ...overrides,
  }
}

const records = [
  record({ id: 'tx_lunch', amount_minor: 3200, category: { l1: 'food' } }),
  record({ id: 'tx_taxi', amount_minor: 1800, category: { l1: 'transport' }, occurred_on: '2026-10-06' }),
  record({ id: 'tx_salary', kind: 'income', amount_minor: 1200000, category: { l1: 'salary' }, occurred_on: '2026-10-10' }),
  record({ id: 'tx_refund', kind: 'refund', amount_minor: 500, occurred_on: '2026-10-11' }),
  record({ id: 'tx_sale', kind: 'sale', book: 'shop', amount_minor: 48000, paid_minor: 0, customer: '老陈', occurred_on: '2026-10-12' }),
  record({ id: 'tx_purchase', kind: 'purchase', book: 'shop', amount_minor: 600000, paid_minor: 0, supplier: '李厂', occurred_on: '2026-10-13' }),
  record({ id: 'tx_repay', kind: 'payment_in', book: 'shop', amount_minor: 30000, paid_minor: 30000, customer: '老陈', occurred_on: '2026-10-20' }),
  record({ id: 'tx_void', status: 'void', amount_minor: 9999, occurred_on: '2026-10-21' }),
]

test('the dashboard is one month of both books', () => {
  const out = buildDashboard({
    records,
    config,
    stats: { dataDir: '/tmp/ledger', entries: records.length, quarantined: 2, bytes: 2048 },
    git: { ready: true, enabled: true, lastError: null },
    month: '2026-10',
    now: new Date('2026-10-26T13:00:00+08:00'),
  })
  assert.equal(out.month, '2026-10')
  assert.equal(out.home.expense_minor, 3200 + 1800)
  assert.equal(out.home.refund_minor, 500)
  assert.equal(out.home.income_minor, 1200000)
  assert.equal(out.home.net_minor, 1200000 - (5000 - 500))
  assert.deepEqual(out.home.by_category.map((row) => row.key), ['food', 'transport'])
  assert.equal(out.home.by_category[0].label, '餐饮')
  assert.equal(out.home.by_category.reduce((sum, row) => sum + row.share_bp, 0), 10000)
  assert.equal(out.shop.sales_minor, 48000)
  assert.equal(out.shop.cash_in_minor, 30000, 'only the repayment moved cash')
  assert.equal(out.shop.receivable_open_minor, undefined, 'debt lives in its own block')
  assert.equal(out.receivable.total_minor, 18000)
  assert.equal(out.receivable.people[0].name, '老陈')
  assert.equal(out.payable.total_minor, 600000)
  assert.equal(out.storage.quarantined, 2)
  assert.equal(out.storage.git_ready, true)
})

test('the void line is not in the recent list', () => {
  const out = buildDashboard({ records, config, month: '2026-10' })
  assert.equal(out.recent.some((row) => row.id === 'tx_void'), false)
  assert.equal(out.recent[0].id, 'tx_repay', 'newest date first')
  assert.equal(out.recent[0].kind_label.length > 0, true)
})

test('six months of history end at the selected month', () => {
  const out = buildDashboard({ records, config, month: '2026-10' })
  assert.equal(out.months.length, 6)
  assert.equal(out.months[0].month, '2026-05')
  assert.equal(out.months[5].month, '2026-10')
  assert.equal(out.months[5].home_spent_minor, 5000)
  assert.equal(out.months[5].shop_sales_minor, 48000)
  assert.equal(out.months[4].home_spent_minor, 0)
})

test('month math survives year boundaries', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('2026-03', -13), '2025-02')
  assert.deepEqual(monthRange('2026-02', 3), ['2025-12', '2026-01', '2026-02'])
  assert.equal(resolveMonth('2026-02'), '2026-02')
  assert.equal(resolveMonth('2026-13'), new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0'))
  assert.equal(resolveMonth(undefined, new Date('2026-10-26T13:00:00+08:00')), '2026-10')
})
