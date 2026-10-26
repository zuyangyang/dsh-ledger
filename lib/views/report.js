/**
 * Derived readings for one book (DESIGN.md 8.2 / 8.3 / 8.7).
 *
 * Everything here is a pure function of the journal: no caching, no writes, and
 * no mixing of the three readings. Cash flow is cash flow; a receivable is
 * never income; margin is not computed at all in v1.
 * @module dsh-ledger/views/report
 */

import { labelOf } from '../categories.js'
import { formatMoney, shanghaiDate } from '../util.js'
import { summarizeDebt } from './debt.js'

const EXPENSE_KINDS = new Set(['expense'])
const INCOME_KINDS = new Set(['income'])
const REFUND_KINDS = new Set(['refund'])
const CASH_IN_KINDS = new Set(['payment_in'])
const CASH_OUT_KINDS = new Set(['payment_out', 'draw'])

function liveConfirmed(records) {
  return records.filter((record) => record.status === 'confirmed')
}

function inMonth(records, month) {
  return records.filter((record) => typeof record.occurred_on === 'string' && record.occurred_on.startsWith(month + '-'))
}

function sum(records, kinds) {
  return records.filter((record) => kinds.has(record.kind)).reduce((total, record) => total + record.amount_minor, 0)
}

function categoryRows(records) {
  const buckets = new Map()
  for (const record of records) {
    const l1 = record.category?.l1 || 'uncategorized'
    const bucket = buckets.get(l1) || { l1, count: 0, amount_minor: 0 }
    bucket.amount_minor += record.amount_minor
    bucket.count += 1
    buckets.set(l1, bucket)
  }
  const total = [...buckets.values()].reduce((acc, row) => acc + row.amount_minor, 0)
  const rows = [...buckets.values()]
    .sort((a, b) => b.amount_minor - a.amount_minor || a.l1.localeCompare(b.l1))
    .map((row) => ({
      l1: row.l1,
      label: row.l1 === 'uncategorized' ? '未归类' : labelOf(row.l1),
      amount_minor: row.amount_minor,
      count: row.count,
      share_bp: total > 0 ? Math.round((row.amount_minor * 10000) / total) : 0,
    }))
  // Integer shares may drift by a basis point or two; fold the drift into the
  // largest row so the percentages sum to 100.00% and never look broken.
  if (rows.length > 0) {
    const drift = 10000 - rows.reduce((acc, row) => acc + row.share_bp, 0)
    rows[0].share_bp += drift
  }
  return { rows, total }
}

/** One day of one book. */
export function summarizeDay(records, { date, book = 'home' }) {
  const all = liveConfirmed(records).filter((record) => record.book === book && record.occurred_on === date)
  const expense = all.filter((record) => EXPENSE_KINDS.has(record.kind))
  const income = all.filter((record) => INCOME_KINDS.has(record.kind))
  const refund = all.filter((record) => REFUND_KINDS.has(record.kind))
  const { rows } = categoryRows(expense)
  const expenseMinor = expense.reduce((total, record) => total + record.amount_minor, 0)
  const refundMinor = refund.reduce((total, record) => total + record.amount_minor, 0)
  const incomeMinor = income.reduce((total, record) => total + record.amount_minor, 0)
  return {
    date,
    book,
    count: all.length,
    expense_minor: expenseMinor,
    refund_minor: refundMinor,
    income_minor: incomeMinor,
    net_minor: incomeMinor - (expenseMinor - refundMinor),
    byCategory: rows,
    uncategorized_count: expense.filter((record) => !record.category?.l1).length,
    entries: all
      .filter((record) => EXPENSE_KINDS.has(record.kind) || INCOME_KINDS.has(record.kind))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        amount_minor: record.amount_minor,
        l1: record.category?.l1 ?? null,
        note: record.note || '',
        merchant: record.merchant || null,
        entered_by: record.entered_by || null,
      })),
  }
}

/** One month of one book. */
export function summarizeMonth(records, { month, book = 'home', from, to } = {}) {
  const scoped = from && to
    ? liveConfirmed(records).filter((record) => record.book === book && record.occurred_on >= from && record.occurred_on <= to)
    : inMonth(liveConfirmed(records).filter((record) => record.book === book), month)
  const expense = scoped.filter((record) => EXPENSE_KINDS.has(record.kind))
  const refund = scoped.filter((record) => REFUND_KINDS.has(record.kind))
  const income = scoped.filter((record) => INCOME_KINDS.has(record.kind))
  const { rows } = categoryRows(expense)
  const byDay = new Map()
  for (const record of scoped) {
    if (!EXPENSE_KINDS.has(record.kind) && !INCOME_KINDS.has(record.kind)) continue
    const bucket = byDay.get(record.occurred_on) || { date: record.occurred_on, expense_minor: 0, income_minor: 0, count: 0 }
    if (EXPENSE_KINDS.has(record.kind)) bucket.expense_minor += record.amount_minor
    if (INCOME_KINDS.has(record.kind)) bucket.income_minor += record.amount_minor
    bucket.count += 1
    byDay.set(record.occurred_on, bucket)
  }
  const expenseMinor = expense.reduce((total, record) => total + record.amount_minor, 0)
  const refundMinor = refund.reduce((total, record) => total + record.amount_minor, 0)
  const incomeMinor = income.reduce((total, record) => total + record.amount_minor, 0)
  const biggest = [...expense]
    .sort((a, b) => b.amount_minor - a.amount_minor || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((record) => ({ id: record.id, amount_minor: record.amount_minor, l1: record.category?.l1 ?? null, note: record.note || '' }))
  return {
    month: month || (from ? from.slice(0, 7) : ''),
    book,
    count: scoped.length,
    expense_minor: expenseMinor,
    refund_minor: refundMinor,
    income_minor: incomeMinor,
    net_minor: incomeMinor - (expenseMinor - refundMinor),
    byCategory: rows,
    byDay: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    biggest,
    uncategorized_count: expense.filter((record) => !record.category?.l1).length,
  }
}

/** Shop cash: what actually moved, plus the debt that did not. */
export function summarizeShopCash(records, { month, from, to } = {}) {
  const confirmed = liveConfirmed(records).filter((record) => record.book === 'shop')
  const scoped = from && to
    ? confirmed.filter((record) => record.occurred_on >= from && record.occurred_on <= to)
    : inMonth(confirmed, month)
  const sales = scoped.filter((record) => record.kind === 'sale')
  const purchases = scoped.filter((record) => record.kind === 'purchase')
  const expenses = scoped.filter((record) => record.kind === 'expense')
  const paymentsIn = scoped.filter((record) => CASH_IN_KINDS.has(record.kind))
  const paymentsOut = scoped.filter((record) => CASH_OUT_KINDS.has(record.kind))
  const salesMinor = sales.reduce((total, record) => total + record.amount_minor, 0)
  const paidOf = (record) => (Number.isInteger(record.paid_minor) ? record.paid_minor : record.amount_minor)
  const cashIn = sales.reduce((total, record) => total + paidOf(record), 0)
    + paymentsIn.reduce((total, record) => total + record.amount_minor, 0)
  const cashOut = purchases.reduce((total, record) => total + paidOf(record), 0)
    + expenses.reduce((total, record) => total + paidOf(record), 0)
    + paymentsOut.reduce((total, record) => total + record.amount_minor, 0)
  const asOf = to || lastDayOfMonth(month || shanghaiDate().slice(0, 7))
  const receivable = summarizeDebt(records, { side: 'receivable', asOf })
  const payable = summarizeDebt(records, { side: 'payable', asOf })
  return {
    month: month || (from ? from.slice(0, 7) : ''),
    from: from || null,
    to: to || null,
    retail_minor: sales.filter((record) => record.channel !== 'wholesale').reduce((total, record) => total + record.amount_minor, 0),
    wholesale_minor: sales.filter((record) => record.channel === 'wholesale').reduce((total, record) => total + record.amount_minor, 0),
    sales_minor: salesMinor,
    sales_count: sales.length,
    cash_in_minor: cashIn,
    cash_out_minor: cashOut,
    cash_net_minor: cashIn - cashOut,
    purchase_paid_minor: purchases.reduce((total, record) => total + paidOf(record), 0),
    purchase_total_minor: purchases.reduce((total, record) => total + record.amount_minor, 0),
    expense_minor: expenses.reduce((total, record) => total + record.amount_minor, 0),
    receivable_open_minor: receivable.total_minor,
    payable_open_minor: payable.total_minor,
  }
}

/** Day report as markdown, safe to paste into the chat or save into Obsidian. */
export function renderDayReport(summary) {
  const lines = ['## ' + summary.date + ' ' + (summary.book === 'shop' ? '店里' : '家里')]
  if (summary.count === 0) {
    lines.push('今天没有记录。')
    return lines.join('\n')
  }
  const parts = []
  if (summary.expense_minor > 0 || summary.refund_minor > 0) {
    const net = summary.expense_minor - summary.refund_minor
    parts.push('支出 ' + formatMoney(net) + (summary.refund_minor > 0 ? '（已扣退款 ' + formatMoney(summary.refund_minor) + '）' : ''))
  }
  if (summary.income_minor > 0) parts.push('收入 ' + formatMoney(summary.income_minor))
  lines.push(parts.join('；') + '，共 ' + summary.count + ' 笔')
  if (summary.byCategory.length > 0) {
    lines.push('')
    lines.push('| 类目 | 金额 | 占比 |')
    lines.push('| --- | --- | --- |')
    for (const row of summary.byCategory) {
      lines.push('| ' + row.label + ' | ' + formatMoney(row.amount_minor) + ' | ' + (row.share_bp / 100).toFixed(2) + '% |')
    }
  }
  if (summary.uncategorized_count > 0) lines.push('', '有 ' + summary.uncategorized_count + ' 笔没归类，说「那笔算餐饮」就能改。')
  return lines.join('\n')
}

/** Month report as markdown. Deliberately silent about margin and budget. */
export function renderMonthReport(summary) {
  const title = summary.book === 'shop' ? '店里' : '家里'
  const lines = ['## ' + (summary.month || '期间') + ' ' + title]
  if (summary.count === 0) {
    lines.push('这个月没有记录。')
    return lines.join('\n')
  }
  const netExpense = summary.expense_minor - summary.refund_minor
  lines.push('')
  if (summary.book === 'shop') {
    lines.push('- 卖出 ' + formatMoney(summary.sales_minor ?? 0))
    lines.push('- 现金净变化 ' + formatMoney(summary.cash_net_minor ?? 0))
  } else {
    lines.push('- 支出 ' + formatMoney(netExpense) + (summary.refund_minor > 0 ? '（含退款 ' + formatMoney(summary.refund_minor) + '）' : ''))
    if (summary.income_minor > 0) lines.push('- 收入 ' + formatMoney(summary.income_minor))
    lines.push('- 净支出 ' + formatMoney(netExpense - summary.income_minor))
  }
  lines.push('- 记录 ' + summary.count + ' 笔')
  if (summary.byCategory.length > 0) {
    lines.push('')
    lines.push('### 分类')
    lines.push('')
    lines.push('| 类目 | 金额 | 占比 | 笔数 |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of summary.byCategory) {
      lines.push('| ' + row.label + ' | ' + formatMoney(row.amount_minor) + ' | ' + (row.share_bp / 100).toFixed(1) + '% | ' + row.count + ' |')
    }
    lines.push('| **合计** | **' + formatMoney(summary.expense_minor) + '** | 100% | ' + summary.byCategory.reduce((n, row) => n + row.count, 0) + ' |')
  }
  if (summary.biggest && summary.biggest.length > 0) {
    lines.push('')
    lines.push('### 最大的几笔')
    for (const row of summary.biggest) {
      lines.push('- ' + formatMoney(row.amount_minor) + ' ' + (row.l1 ? labelOf(row.l1) : '未归类') + (row.note ? '（' + row.note + '）' : ''))
    }
  }
  if (summary.uncategorized_count > 0) {
    lines.push('', '有 ' + summary.uncategorized_count + ' 笔还没归类；说「那笔算交通」我就改。')
  }
  return lines.join('\n')
}

function lastDayOfMonth(month) {
  const [year, mon] = String(month).split('-').map(Number)
  if (!year || !mon) return shanghaiDate()
  const date = new Date(Date.UTC(year, mon, 0))
  return date.toISOString().slice(0, 10)
}
