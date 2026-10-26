import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SPAN_DAYS,
  addDays,
  bucketFor,
  buildRangeDashboard,
  displayName,
  rangeLabel,
  resolveRange,
  spanDays,
  weekStartOf,
} from '../lib/range.js'
import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig({})
const NOW = new Date('2026-11-25T17:52:10+08:00')

function record(overrides) {
  return {
    id: 'tx_' + Math.random().toString(36).slice(2, 10),
    schema: 2, version: 1, kind: 'expense', status: 'confirmed', book: 'home',
    amount_minor: 3200, currency: 'CNY', occurred_on: '2026-11-05',
    paid_minor: 3200, category: { l1: 'food', l2: null, source: 'builtin' },
    merchant: null, customer: null, supplier: null, channel: null,
    entered_by: 'yang', created_at: '2026-11-05T12:00:00+08:00',
    note: '', ...overrides,
  }
}

function build(records, extra = {}) {
  return buildRangeDashboard({ records, config, from: '2026-11-01', to: '2026-11-30', now: NOW, ...extra })
}

test('an empty request means the last 30 days including today', () => {
  const range = resolveRange({ now: NOW })
  assert.deepEqual(range, { ok: true, from: '2026-10-27', to: '2026-11-25', days: 30 })
  assert.equal(rangeLabel({ from: '2026-10-27', to: '2026-11-25', days: 30, now: NOW }), '近 30 天')
  assert.equal(rangeLabel({ from: '2026-11-19', to: '2026-11-25', days: 7, now: NOW }), '近 7 天')
  assert.equal(rangeLabel({ from: '2026-11-01', to: '2026-11-30', days: 30, now: NOW }), '本月')
  assert.equal(rangeLabel({ from: '2026-10-01', to: '2026-10-31', days: 31, now: NOW }), '上月')
  assert.equal(rangeLabel({ from: '2026-09-01', to: '2026-09-03', days: 3, now: NOW }), '09-01 → 09-03')
})

test('a bad range is refused with a readable reason', () => {
  assert.match(resolveRange({ from: '2026-11-31', to: '2026-12-01', now: NOW }).error, /YYYY-MM-DD/)
  assert.match(resolveRange({ from: '2026-11-20', to: '2026-11-01', now: NOW }).error, /不能晚于/)
  const tooLong = resolveRange({ from: addDays('2026-11-25', -MAX_SPAN_DAYS), to: '2026-11-25', now: NOW })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.error, /最多看 366 天/)
  assert.equal(resolveRange({ from: '2024-02-29', to: '2024-02-29', now: NOW }).ok, true, 'a leap day is a real day')
  assert.equal(spanDays('2026-11-01', '2026-11-30'), 30)
})

test('long ranges fall back to whole weeks, short ones stay daily', () => {
  assert.equal(bucketFor(30), 'day')
  assert.equal(bucketFor(62), 'day')
  assert.equal(bucketFor(63), 'week')
  assert.equal(weekStartOf('2026-11-25'), '2026-11-23', 'a Wednesday belongs to the Monday week')
  const wide = buildRangeDashboard({
    records: [record({ occurred_on: '2026-11-25', amount_minor: 100 })],
    config, from: '2026-06-01', to: '2026-11-30', now: NOW,
  })
  assert.equal(wide.series.bucket, 'week')
  assert.equal(wide.series.points.length, 27)
  assert.equal(wide.series.points.reduce((sum, point) => sum + point.home_expense_minor, 0), 100)
})

test('every day of the range gets a point, even an empty one', () => {
  const out = build([record({ occurred_on: '2026-11-03', amount_minor: 900 })])
  assert.equal(out.series.points.length, 30)
  assert.equal(out.series.points[0].key, '2026-11-01')
  assert.equal(out.series.points[2].home_expense_minor, 900)
  assert.equal(out.series.points[1].home_expense_minor, 0)
  assert.equal(out.range.days, 30)
})

test('refunds reduce spending and are never income', () => {
  const out = build([
    record({ amount_minor: 5000, category: { l1: 'food' } }),
    record({ kind: 'refund', amount_minor: 500 }),
    record({ kind: 'income', amount_minor: 20000, category: { l1: 'salary' } }),
  ])
  assert.equal(out.totals.home.expense_minor, 5000)
  assert.equal(out.totals.home.refund_minor, 500)
  assert.equal(out.totals.home.income_minor, 20000)
  assert.equal(out.totals.home.net_minor, 20000 - 4500)
  assert.equal(out.categories.rows[0].minor, 5000, 'a refund never shrinks a category')
  assert.match(out.summary[0].text, /家里花了 ¥45\.00/)
})

test('a credit sale is sales, not cash, and never household income', () => {
  const out = build([
    record({ kind: 'sale', book: 'shop', amount_minor: 48000, paid_minor: 0, customer: '老陈', entered_by: 'ma' }),
    record({ kind: 'sale', book: 'shop', amount_minor: 20000, paid_minor: 20000, customer: '散客' }),
    record({ kind: 'purchase', book: 'shop', amount_minor: 600000, paid_minor: 100000, supplier: '李厂' }),
    record({ kind: 'payment_in', book: 'shop', amount_minor: 10000, paid_minor: 10000, customer: '老陈', occurred_on: '2026-11-20' }),
    record({ kind: 'draw', book: 'shop', amount_minor: 5000 }),
  ])
  assert.equal(out.totals.shop.sales_minor, 68000)
  assert.equal(out.totals.shop.credit_out_minor, 48000)
  assert.equal(out.totals.shop.cash_in_minor, 30000)
  assert.equal(out.totals.shop.cash_out_minor, 105000)
  assert.equal(out.totals.shop.cash_net_minor, -75000)
  assert.equal(out.totals.home.expense_minor, 0, 'home is present but empty when only the shop moved')
  assert.equal(out.debt.receivable.total_minor, 48000 - 10000)
})

test('a transfer is cash movement, never spending', () => {
  const out = build([
    record({ kind: 'transfer', amount_minor: 100000, category: { l1: 'other' } }),
    record({ amount_minor: 1200 }),
  ])
  assert.equal(out.totals.home.count, 2)
  assert.equal(out.totals.home.expense_minor, 1200)
  assert.equal(out.categories.total_minor, 1200)
  assert.equal(out.series.points.reduce((sum, point) => sum + point.count, 0), 2)
})

test('records outside the range, and void records, are invisible', () => {
  const out = build([
    record({ occurred_on: '2026-10-31', amount_minor: 999 }),
    record({ occurred_on: '2026-11-01', amount_minor: 100 }),
    record({ occurred_on: '2026-11-30', amount_minor: 200 }),
    record({ occurred_on: '2026-12-01', amount_minor: 888 }),
    record({ occurred_on: '2026-11-15', amount_minor: 777, status: 'void' }),
  ])
  assert.equal(out.totals.home.expense_minor, 300)
  assert.equal(out.storage.matched, 2)
  assert.equal(out.recent.length, 2)
})

test('the previous window makes "more than last time" possible, and stays silent otherwise', () => {
  const out = build([record({ occurred_on: '2026-11-10', amount_minor: 11000 })])
  assert.equal(out.compare.previous_minor, 0)
  assert.equal(out.compare.comparable, false)
  assert.equal(out.summary.some((line) => line.kind === 'compare'), false)

  const busy = build([
    record({ occurred_on: '2026-10-20', amount_minor: 10000 }),
    record({ occurred_on: '2026-11-10', amount_minor: 11000 }),
  ])
  assert.equal(busy.compare.previous_minor, 10000)
  assert.equal(busy.compare.delta_minor, 1000)
  assert.equal(busy.compare.delta_bp, 1000)
  assert.equal(busy.compare.comparable, true)
  assert.match(busy.summary.find((line) => line.kind === 'compare').text, /多 10\.0%（¥10\.00）/)
})

test('categories keep 未归类 out of the shares and say so', () => {
  const out = build([
    record({ amount_minor: 3000, category: { l1: 'food' } }),
    record({ amount_minor: 1000, category: { l1: 'transport' } }),
    record({ amount_minor: 700, category: null }),
  ])
  assert.deepEqual(out.categories.rows.map((row) => row.label), ['餐饮', '交通'])
  assert.equal(out.categories.rows.reduce((sum, row) => sum + row.share_bp, 0), 10000)
  assert.deepEqual(out.categories.uncategorized, { minor: 700, count: 1 })
  assert.equal(out.totals.home.uncategorized_count, 1)
  assert.match(out.summary[0].text, /另有 1 笔未归类/)
})

test('per person means who recorded it, by name, with an id fallback', () => {
  const out = build([
    record({ entered_by: 'ma', amount_minor: 2000, category: { l1: 'food' } }),
    record({ entered_by: 'ma', amount_minor: 1000, category: { l1: 'food' } }),
    record({ entered_by: 'o9cq806iHQU_36NTUmykZDjLCY14@im.wechat', amount_minor: 100, category: { l1: 'transport' } }),
    record({ entered_by: null, amount_minor: 50 }),
    record({ book: 'shop', kind: 'sale', entered_by: 'ma', amount_minor: 9000, paid_minor: 9000 }),
  ], { group: 'actor', actorNames: { ma: '妈' } })

  assert.equal(out.actors.length, 3)
  const ma = out.actors.find((row) => row.key === 'ma')
  assert.equal(ma.name, '妈')
  assert.equal(ma.name_source, 'alias')
  assert.equal(ma.count, 3, 'shop sales count as records by that person')
  assert.equal(ma.expense_minor, 3000)
  assert.equal(ma.share_bp, 9524)
  assert.equal(ma.points.length, 30)
  assert.equal(ma.points.reduce((sum, point) => sum + point.minor, 0), 3000)

  const wechat = out.actors.find((row) => row.name_source === 'id')
  assert.equal(wechat.name, '微信用户·o9cq806i')
  assert.equal(describeSafely(wechat.key), 'o9cq806iHQU_36NTUmykZDjLCY14@im.wechat')

  const unknown = out.actors.find((row) => row.name_source === 'unknown')
  assert.equal(unknown.name, '未记录')
  assert.equal(out.summary.find((line) => line.kind === 'people').text, '3 人记过账，妈最多（95.2%，3 笔）。')
})

test('a display name is a name, an alias, or a short id', () => {
  assert.equal(displayName('妈'), '妈')
  assert.equal(displayName('o9cq806iHQU_36NTUmykZDjLCY14@im.wechat'), '微信用户·o9cq806i')
  assert.equal(displayName('unknown'), '未记录')
  assert.equal(displayName(null), '未记录')
  assert.equal(displayName('o9cq806iHQU_36NTUmykZDjLCY14@im.wechat', { 'o9cq806iHQU_36NTUmykZDjLCY14@im.wechat': '妈' }), '妈')
})

test('the recent list shows the newest records from both books', () => {
  const out = build([
    record({ occurred_on: '2026-11-03', note: '午饭', created_at: '2026-11-03T12:00:00+08:00' }),
    record({ occurred_on: '2026-11-20', note: '超市', amount_minor: 32000, merchant: '超市', created_at: '2026-11-20T12:00:00+08:00' }),
    record({ book: 'shop', kind: 'sale', occurred_on: '2026-11-21', amount_minor: 48000, customer: '老陈', created_at: '2026-11-21T12:00:00+08:00' }),
  ])
  assert.deepEqual(out.recent.map((row) => row.date), ['2026-11-21', '2026-11-20', '2026-11-03'])
  assert.equal(out.recent[0].counterparty, '老陈')
  assert.equal(out.recent[1].category_label, '餐饮')
  assert.equal(out.recent[0].kind_label, '卖出')
  assert.equal(out.recent.length, 3)
  assert.equal(out.top[0].note, '超市')
})

test('debt is read as of the end of the range, not the start', () => {
  const out = build([
    record({ kind: 'sale', book: 'shop', amount_minor: 50000, paid_minor: 0, customer: '老陈', occurred_on: '2026-11-10' }),
  ])
  assert.equal(out.debt.as_of, '2026-11-30')
  assert.equal(out.debt.receivable.total_minor, 50000)
  assert.equal(out.debt.receivable.people[0].name, '老陈')
  assert.equal(out.debt.payable.total_minor, 0)
})

test('the books can be filtered, and the payload only carries what was asked', () => {
  const records = [
    record({ amount_minor: 3200, entered_by: 'yang' }),
    record({ book: 'shop', kind: 'sale', amount_minor: 9000, paid_minor: 0, customer: '老陈' }),
  ]
  const homeOnly = build(records, { book: 'home' })
  assert.equal(homeOnly.totals.shop, undefined)
  assert.equal(homeOnly.totals.home.expense_minor, 3200)
  assert.equal(homeOnly.debt.receivable.total_minor, 9000, 'debt still counts the shop, it is a separate reading')

  const shopOnly = build(records, { book: 'shop' })
  assert.equal(shopOnly.totals.home, undefined)
  assert.equal(shopOnly.totals.shop.sales_minor, 9000)
  assert.equal(shopOnly.totals.shop.credit_out_minor, 9000)
  assert.deepEqual(shopOnly.categories.rows, [])
  assert.deepEqual(shopOnly.top, [])
  assert.equal(shopOnly.series.points.reduce((sum, point) => sum + point.home_expense_minor, 0), 0)
})

test('an empty range still answers in the same shape', () => {
  const out = build([])
  assert.equal(out.totals.home.expense_minor, 0)
  assert.equal(out.series.points.length, 30)
  assert.deepEqual(out.categories.rows, [])
  assert.deepEqual(out.recent, [])
  assert.equal(out.debt.receivable.total_minor, 0)
  assert.deepEqual(out.summary, [{ kind: 'empty', text: '这段时间没有记录。' }])
})

test('an impossible range is reported, not thrown', () => {
  const out = buildRangeDashboard({ records: [], config, from: '2026-12-01', to: '2026-11-01', now: NOW })
  assert.match(out.error, /不能晚于/)
})

function describeSafely(value) {
  return value
}