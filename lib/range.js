/**
 * Any date range, aggregated for the floating dashboard (DASHBOARD.md 5).
 *
 * Same rule as the rest of the views: a pure function of the journal, no
 * cache, and the three readings never mix — household spending/income, shop
 * cash, and what is still owed are three separate blocks, and no block ever
 * subtracts spending from income to claim a profit.
 * @module dsh-ledger/range
 */

import { labelOf } from './categories.js'
import { summarizeDebt } from './views/debt.js'
import { kindLabel } from './receipt.js'
import { formatMoney, shanghaiDate, shanghaiIso } from './util.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A range may not be longer than a leap year: bounds the work, not the data. */
export const MAX_SPAN_DAYS = 366

/** Above this, one bar per day stops being readable, so the series goes weekly. */
export const WEEK_BUCKET_AFTER_DAYS = 62

const HOME_EXPENSE = new Set(['expense'])
const HOME_INCOME = new Set(['income'])
const HOME_REFUND = new Set(['refund'])

/** True for a real calendar day written as YYYY-MM-DD. */
export function isDay(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const time = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

/** Shift a YYYY-MM-DD by n days (calendar arithmetic, no time zone involved). */
export function addDays(day, delta) {
  const time = Date.parse(day + 'T00:00:00Z')
  return new Date(time + delta * 86400000).toISOString().slice(0, 10)
}

/** Inclusive day count: (to - from) + 1. */
export function spanDays(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1
}

/**
 * The range a request means. Defaults to the last 30 days including today,
 * because that is the question people actually ask.
 * @returns {{ok: true, from: string, to: string, days: number} | {ok: false, error: string}}
 */
export function resolveRange({ from, to, now = new Date() } = {}) {
  const today = shanghaiDate(now)
  const end = to === undefined || to === null || to === '' ? today : to
  if (!isDay(end)) return { ok: false, error: 'to 必须是 YYYY-MM-DD 日期' }
  const start = from === undefined || from === null || from === '' ? addDays(end, -29) : from
  if (!isDay(start)) return { ok: false, error: 'from 必须是 YYYY-MM-DD 日期' }
  if (start > end) return { ok: false, error: 'from 不能晚于 to' }
  const days = spanDays(start, end)
  if (days > MAX_SPAN_DAYS) return { ok: false, error: '一次最多看 ' + MAX_SPAN_DAYS + ' 天' }
  return { ok: true, from: start, to: end, days }
}

/** Human label for a range: a preset name when it matches one, else the dates. */
export function rangeLabel({ from, to, days, now = new Date() } = {}) {
  const today = shanghaiDate(now)
  if (to === today && days === 30) return '近 30 天'
  if (to === today && days === 7) return '近 7 天'
  const thisMonth = today.slice(0, 7)
  const lastMonth = monthShift(thisMonth, -1)
  if (from === thisMonth + '-01' && to === lastDayOfMonth(thisMonth)) return '本月'
  if (from === lastMonth + '-01' && to === lastDayOfMonth(lastMonth)) return '上月'
  return from.slice(5) + ' → ' + to.slice(5)
}

/** 'day' for a readable bar per day, 'week' for longer ranges. */
export function bucketFor(days) {
  return days > WEEK_BUCKET_AFTER_DAYS ? 'week' : 'day'
}

/**
 * One range of both books, ready to draw.
 * @param {{records?: object[], config?: object, stats?: object, git?: object, from?: string, to?: string, group?: string, book?: string, actorNames?: object, now?: Date, recentLimit?: number, topLimit?: number}} input
 */
export function buildRangeDashboard({
  records = [],
  config = {},
  stats = {},
  git = null,
  from,
  to,
  group = 'book',
  book = 'all',
  actorNames = {},
  now = new Date(),
  recentLimit = 10,
  topLimit = 5,
} = {}) {
  const range = resolveRange({ from, to, now })
  if (!range.ok) return { error: range.error }
  const bounds = { from: range.from, to: range.to, days: range.days }
  const days = bounds.days
  const bucket = bucketFor(days)

  const scoped = records.filter((record) => {
    if (record.status !== 'confirmed') return false
    if (typeof record.occurred_on !== 'string') return false
    if (record.occurred_on < bounds.from || record.occurred_on > bounds.to) return false
    if (book !== 'all' && record.book !== book) return false
    return true
  })

  const homeRecords = scoped.filter((record) => record.book === 'home')
  const shopRecords = scoped.filter((record) => record.book === 'shop')

  const totals = {}
  if (book !== 'shop') totals.home = homeTotals(homeRecords, days)
  if (book !== 'home') totals.shop = shopTotals(shopRecords)

  const points = buildSeries({ homeRecords, shopRecords, from: bounds.from, to: bounds.to, bucket, group })

  const payload = {
    range: { ...bounds, label: rangeLabel({ ...bounds, now }), bucket },
    generated_at: shanghaiIso(now),
    storage: {
      data_dir: stats.dataDir ?? config.dataDir ?? null,
      is_default: config.dataDirIsDefault === true,
      default_data_dir: config.defaultDataDir ?? null,
      entries: stats.entries ?? 0,
      quarantined: stats.quarantined ?? 0,
      bytes: stats.bytes ?? 0,
      matched: scoped.length,
      git_ready: git?.ready === true,
      git_enabled: git?.enabled !== false,
      git_error: git?.lastError ?? null,
      git_nested_in: git?.nestedRepo ?? null,
    },
    totals,
    series: { bucket, points },
    categories: book === 'shop' ? { rows: [], total_minor: 0, uncategorized: { minor: 0, count: 0 } } : categoryRows(homeRecords),
    top: book === 'shop' ? [] : topExpenses(homeRecords, actorNames, topLimit),
    recent: recentRows(scoped, actorNames, recentLimit),
    debt: {
      as_of: bounds.to,
      receivable: debtSide(records, 'receivable', bounds.to),
      payable: debtSide(records, 'payable', bounds.to),
    },
    compare: compareRange({ records, book, bounds }),
  }

  if (group === 'actor') {
    payload.actors = actorRows({ homeRecords, shopRecords, actorNames, from: bounds.from, to: bounds.to, bucket })
  }

  payload.summary = summarize({ range: payload.range, totals, categories: payload.categories, top: payload.top, actors: payload.actors, compare: payload.compare, group, matched: scoped.length })
  return payload
}

function homeTotals(records, days) {
  const expense = records.filter((record) => HOME_EXPENSE.has(record.kind))
  const refund = records.filter((record) => HOME_REFUND.has(record.kind))
  const income = records.filter((record) => HOME_INCOME.has(record.kind))
  const expenseMinor = sumOf(expense)
  const refundMinor = sumOf(refund)
  const incomeMinor = sumOf(income)
  const activeDays = new Set(records.map((record) => record.occurred_on)).size
  return {
    count: records.length,
    expense_minor: expenseMinor,
    refund_minor: refundMinor,
    income_minor: incomeMinor,
    net_minor: incomeMinor - (expenseMinor - refundMinor),
    uncategorized_count: expense.filter((record) => !record.category?.l1).length,
    active_days: activeDays,
    avg_per_day_minor: days > 0 ? Math.round((expenseMinor - refundMinor) / days) : 0,
  }
}

function shopTotals(records) {
  const sales = records.filter((record) => record.kind === 'sale')
  const purchases = records.filter((record) => record.kind === 'purchase')
  const expenses = records.filter((record) => record.kind === 'expense')
  const paymentsIn = records.filter((record) => record.kind === 'payment_in')
  const paymentsOut = records.filter((record) => record.kind === 'payment_out' || record.kind === 'draw')
  const salesMinor = sumOf(sales)
  const cashIn = sales.reduce((total, record) => total + paidOf(record), 0) + sumOf(paymentsIn)
  const cashOut = purchases.reduce((total, record) => total + paidOf(record), 0)
    + expenses.reduce((total, record) => total + paidOf(record), 0)
    + sumOf(paymentsOut)
  const creditOut = sales.reduce((total, record) => total + (record.amount_minor - paidOf(record)), 0)
  return {
    count: records.length,
    sales_minor: salesMinor,
    sales_count: sales.length,
    retail_minor: sumOf(sales.filter((record) => record.channel !== 'wholesale')),
    wholesale_minor: sumOf(sales.filter((record) => record.channel === 'wholesale')),
    cash_in_minor: cashIn,
    cash_out_minor: cashOut,
    cash_net_minor: cashIn - cashOut,
    credit_out_minor: creditOut,
    purchase_total_minor: sumOf(purchases),
    purchase_paid_minor: purchases.reduce((total, record) => total + paidOf(record), 0),
    expense_minor: sumOf(expenses),
    uncategorized_count: expenses.filter((record) => !record.category?.l1).length,
  }
}

function sumOf(records) {
  return records.reduce((total, record) => total + record.amount_minor, 0)
}

function paidOf(record) {
  return Number.isInteger(record.paid_minor) ? record.paid_minor : record.amount_minor
}

/** One point per bucket: the home days a chart draws, plus the shop money that moved. */
function buildSeries({ homeRecords, shopRecords, from, to, bucket, group }) {
  const keys = []
  for (let index = 0; index < spanDays(from, to); index += 1) {
    const day = addDays(from, index)
    const key = bucket === 'week' ? weekStartOf(day) : day
    if (keys[keys.length - 1] !== key) keys.push(key)
  }
  const byKey = new Map(keys.map((key) => [key, {
    key,
    label: bucket === 'week' ? key.slice(5) + ' 周' : key.slice(5),
    home_expense_minor: 0,
    home_income_minor: 0,
    home_refund_minor: 0,
    shop_sales_minor: 0,
    shop_cash_net_minor: 0,
    count: 0,
    by_actor: group === 'actor' ? {} : undefined,
  }]))

  const keyOf = (day) => (bucket === 'week' ? weekStartOf(day) : day)
  for (const record of homeRecords) {
    const point = byKey.get(keyOf(record.occurred_on))
    if (!point) continue
    if (HOME_EXPENSE.has(record.kind)) point.home_expense_minor += record.amount_minor
    if (HOME_INCOME.has(record.kind)) point.home_income_minor += record.amount_minor
    if (HOME_REFUND.has(record.kind)) point.home_refund_minor += record.amount_minor
    point.count += 1
    if (group === 'actor' && HOME_EXPENSE.has(record.kind)) {
      const actor = record.entered_by || 'unknown'
      point.by_actor[actor] = (point.by_actor[actor] || 0) + record.amount_minor
    }
  }
  for (const record of shopRecords) {
    const point = byKey.get(keyOf(record.occurred_on))
    if (!point) continue
    if (record.kind === 'sale') {
      point.shop_sales_minor += record.amount_minor
      point.shop_cash_net_minor += paidOf(record)
    }
    if (record.kind === 'payment_in') point.shop_cash_net_minor += record.amount_minor
    if (record.kind === 'purchase' || record.kind === 'expense') point.shop_cash_net_minor -= paidOf(record)
    if (record.kind === 'payment_out' || record.kind === 'draw') point.shop_cash_net_minor -= record.amount_minor
    point.count += 1
  }

  return keys.map((key) => byKey.get(key))
}

/** Monday of the ISO week containing a day (dates are UTC-parsed on purpose). */
export function weekStartOf(day) {
  const time = Date.parse(day + 'T00:00:00Z')
  const weekday = (new Date(time).getUTCDay() + 6) % 7
  return addDays(day, -weekday)
}

/** Spending by category, with 未归类 kept apart instead of folded into 其他. */
function categoryRows(records) {
  const buckets = new Map()
  for (const record of records) {
    if (!HOME_EXPENSE.has(record.kind)) continue
    const l1 = record.category?.l1 || 'uncategorized'
    const bucket = buckets.get(l1) || { l1, count: 0, minor: 0 }
    bucket.minor += record.amount_minor
    bucket.count += 1
    buckets.set(l1, bucket)
  }
  const categorized = [...buckets.values()].filter((row) => row.l1 !== 'uncategorized')
  const total = categorized.reduce((acc, row) => acc + row.minor, 0)
  const rows = categorized
    .sort((a, b) => b.minor - a.minor || a.l1.localeCompare(b.l1))
    .map((row) => ({
      key: row.l1,
      label: labelOf(row.l1),
      minor: row.minor,
      count: row.count,
      share_bp: total > 0 ? Math.round((row.minor * 10000) / total) : 0,
    }))
  if (rows.length > 0) {
    const drift = 10000 - rows.reduce((acc, row) => acc + row.share_bp, 0)
    rows[0].share_bp += drift
  }
  const uncategorized = buckets.get('uncategorized')
  return {
    rows,
    total_minor: total,
    uncategorized: uncategorized ? { minor: uncategorized.minor, count: uncategorized.count } : { minor: 0, count: 0 },
  }
}

function topExpenses(records, actorNames, limit) {
  return records
    .filter((record) => HOME_EXPENSE.has(record.kind))
    .sort((a, b) => b.amount_minor - a.amount_minor || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      date: record.occurred_on,
      amount_minor: record.amount_minor,
      counterparty: record.merchant || null,
      category_label: record.category?.l1 ? labelOf(record.category.l1) : '未归类',
      note: record.note || '',
      entered_by_name: displayName(record.entered_by, actorNames),
    }))
}

function recentRows(records, actorNames, limit) {
  return [...records]
    .sort((a, b) => (a.occurred_on === b.occurred_on
      ? String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id).localeCompare(String(a.id))
      : (a.occurred_on < b.occurred_on ? 1 : -1)))
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      date: record.occurred_on,
      book: record.book,
      kind: record.kind,
      kind_label: kindLabel(record.kind),
      amount_minor: record.amount_minor,
      paid_minor: paidOf(record),
      category_label: record.category?.l1 ? labelOf(record.category.l1) : null,
      counterparty: record.merchant || record.customer || record.supplier || null,
      note: record.note || '',
      entered_by_name: displayName(record.entered_by, actorNames),
      status: record.status,
    }))
}

function debtSide(records, side, asOf) {
  const summary = summarizeDebt(records, { side, asOf })
  return {
    total_minor: summary.total_minor,
    people_count: summary.people_count,
    scattered_minor: summary.scattered_minor,
    people: summary.people.slice(0, 3).map((person) => ({
      name: person.name,
      open_minor: person.open_minor,
      age_days: person.age_days,
      oldest_on: person.oldest_on,
    })),
  }
}

/** The window immediately before this one, same length, for "more than last time". */
function compareRange({ records, book, bounds }) {
  const previousTo = addDays(bounds.from, -1)
  const previousFrom = addDays(previousTo, -(bounds.days - 1))
  const inWindow = (from, to) => records.filter((record) => record.status === 'confirmed'
    && record.occurred_on >= from && record.occurred_on <= to
    && (book === 'all' || record.book === book))
  const previousRows = inWindow(previousFrom, previousTo)
  const currentRows = inWindow(bounds.from, bounds.to)
  const spendOf = (rows) => rows
    .filter((record) => record.book === 'home' && HOME_EXPENSE.has(record.kind))
    .reduce((total, record) => total + record.amount_minor, 0)
  const refundOf = (rows) => rows
    .filter((record) => record.book === 'home' && HOME_REFUND.has(record.kind))
    .reduce((total, record) => total + record.amount_minor, 0)
  const previousMinor = spendOf(previousRows) - refundOf(previousRows)
  const currentMinor = spendOf(currentRows) - refundOf(currentRows)
  return {
    from: previousFrom,
    to: previousTo,
    previous_minor: previousMinor,
    current_minor: currentMinor,
    delta_minor: currentMinor - previousMinor,
    delta_bp: previousMinor > 0 ? Math.round(((currentMinor - previousMinor) * 10000) / previousMinor) : 0,
    comparable: previousRows.length > 0 && previousMinor > 0,
  }
}

/**
 * Who recorded what. "Per person" is the recorder, never a guess at who spent
 * the money, and a raw IM id is shown as a name-shaped fallback rather than
 * being anonymised away (DASHBOARD.md 8.1).
 */
function actorRows({ homeRecords, shopRecords, actorNames, from, to, bucket }) {
  const buckets = new Map()
  const ensure = (key) => {
    const found = buckets.get(key)
    if (found) return found
    const created = {
      key,
      name: displayName(key, actorNames),
      name_source: nameSourceOf(key, actorNames),
      count: 0,
      expense_minor: 0,
      income_minor: 0,
      refund_minor: 0,
      uncategorized_count: 0,
      last_on: null,
      _pointMap: new Map(),
    }
    buckets.set(key, created)
    return created
  }
  for (const record of [...homeRecords, ...shopRecords]) {
    const row = ensure(record.entered_by || 'unknown')
    row.count += 1
    if (record.book === 'home') {
      if (HOME_EXPENSE.has(record.kind)) {
        row.expense_minor += record.amount_minor
        if (!record.category?.l1) row.uncategorized_count += 1
        const key = bucket === 'week' ? weekStartOf(record.occurred_on) : record.occurred_on
        row._pointMap.set(key, (row._pointMap.get(key) || 0) + record.amount_minor)
      }
      if (HOME_INCOME.has(record.kind)) row.income_minor += record.amount_minor
      if (HOME_REFUND.has(record.kind)) row.refund_minor += record.amount_minor
    }
    if (!row.last_on || record.occurred_on > row.last_on) row.last_on = record.occurred_on
  }
  const keys = []
  for (let index = 0; index < spanDays(from, to); index += 1) {
    const key = bucket === 'week' ? weekStartOf(addDays(from, index)) : addDays(from, index)
    if (keys[keys.length - 1] !== key) keys.push(key)
  }
  const totalExpense = [...buckets.values()].reduce((acc, row) => acc + row.expense_minor, 0)
  return [...buckets.values()]
    .sort((a, b) => b.expense_minor - a.expense_minor || b.count - a.count || a.name.localeCompare(b.name))
    .map(({ _pointMap, ...row }) => ({
      ...row,
      points: keys.map((key) => ({ key, minor: _pointMap.get(key) || 0 })),
      share_bp: totalExpense > 0 ? Math.round((row.expense_minor * 10000) / totalExpense) : 0,
    }))
}

/** A person's display name: alias, then the value itself, then a short id. */
export function displayName(value, actorNames = {}) {
  if (value === undefined || value === null || value === '') return '未记录'
  const key = String(value)
  if (key === 'unknown') return '未记录'
  const alias = actorNames[key]
  if (typeof alias === 'string' && alias.trim().length > 0) return alias.trim()
  if (!looksLikeId(key)) return key
  // An IM id still tells us these entries came from one person; show it short
  // and say where it came from instead of hiding it behind "未知".
  const local = key.split('@')[0]
  return '微信用户·' + local.slice(0, 8)
}

function nameSourceOf(value, actorNames = {}) {
  if (value === undefined || value === null || value === '' || value === 'unknown') return 'unknown'
  const key = String(value)
  const alias = actorNames[key]
  if (typeof alias === 'string' && alias.trim().length > 0) return 'alias'
  return looksLikeId(key) ? 'id' : 'entered_by'
}

function looksLikeId(value) {
  return value.includes('@') || /^[A-Za-z0-9_-]{16,}$/.test(value)
}

/** Human summary lines, built here so chat tools and the panel word it the same. */
function summarize({ range, totals, categories, top, actors, compare, group, matched }) {
  // Nothing in range: one plain sentence beats four cards of zeroes.
  if (matched === 0) return [{ kind: 'empty', text: '这段时间没有记录。' }]
  const lines = []
  const days = range.days
  const home = totals.home
  if (home) {
    const spent = home.expense_minor - home.refund_minor
    const perDay = days > 0 ? Math.round(spent / days) : 0
    let text = range.label + '家里花了 ' + formatMoney(spent) + '，日均 ' + formatMoney(perDay) + '。'
    if (home.income_minor > 0) text += '收入 ' + formatMoney(home.income_minor) + '，净 ' + signed(home.net_minor) + '。'
    if (home.uncategorized_count > 0) text += '另有 ' + home.uncategorized_count + ' 笔未归类。'
    lines.push({ kind: 'volume', text })
  }
  if (compare?.comparable && compare.delta_minor !== 0) {
    const word = compare.delta_minor > 0 ? '多' : '少'
    const percent = (Math.abs(compare.delta_bp) / 100).toFixed(1)
    lines.push({
      kind: 'compare',
      text: '比上一个 ' + days + ' 天' + word + ' ' + percent + '%（' + formatMoney(Math.abs(compare.delta_minor)) + '）。',
    })
  }
  const topCategory = categories?.rows?.[0]
  const biggest = top?.[0]
  if (topCategory && topCategory.share_bp >= 2000) {
    let text = '花得最多的是「' + topCategory.label + '」' + formatMoney(topCategory.minor)
      + '（' + (topCategory.share_bp / 100).toFixed(1) + '%）'
    if (biggest) text += '；最大一笔 ' + biggest.date.slice(5) + '「' + describeEntry(biggest) + '」' + formatMoney(biggest.amount_minor)
    lines.push({ kind: 'breakdown', text: text + '。' })
  } else if (biggest) {
    lines.push({ kind: 'breakdown', text: '最大一笔 ' + biggest.date.slice(5) + '「' + describeEntry(biggest) + '」' + formatMoney(biggest.amount_minor) + '。' })
  }
  const shop = totals.shop
  if (shop && (shop.sales_minor > 0 || shop.cash_in_minor > 0 || shop.cash_out_minor > 0)) {
    let text = '店里卖出 ' + formatMoney(shop.sales_minor) + '（' + shop.sales_count + ' 单）'
      + '，实收 ' + formatMoney(shop.cash_in_minor)
      + (shop.credit_out_minor > 0 ? '、赊出 ' + formatMoney(shop.credit_out_minor) : '')
      + '，现金净 ' + signed(shop.cash_net_minor) + '。'
    lines.push({ kind: 'shop', text })
  }
  if (group === 'actor' && actors && actors.length > 0) {
    const topActor = actors[0]
    lines.push({
      kind: 'people',
      text: actors.length + ' 人记过账，' + topActor.name + '最多（' + (topActor.share_bp / 100).toFixed(1) + '%，' + topActor.count + ' 笔）。',
    })
  }
  if (lines.length === 0) lines.push({ kind: 'empty', text: '这段时间没有记录。' })
  return lines
}

/** A short human handle for one record: what it was, else where, else the category. */
function describeEntry(entry) {
  const text = String(entry.counterparty || entry.note || '').trim()
  if (text.length > 0) return text.slice(0, 12)
  return entry.category_label || '一笔'
}

function signed(minor) {
  if (minor === 0) return formatMoney(0)
  return (minor > 0 ? '+' : '−') + formatMoney(Math.abs(minor))
}

function monthShift(month, delta) {
  const year = Number(month.slice(0, 4))
  const index = year * 12 + (Number(month.slice(5, 7)) - 1) + delta
  const nextYear = Math.floor(index / 12)
  const nextMonth = (index % 12 + 12) % 12 + 1
  return String(nextYear) + '-' + String(nextMonth).padStart(2, '0')
}

function lastDayOfMonth(month) {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  return month + '-' + String(new Date(Date.UTC(year, index, 0)).getUTCDate()).padStart(2, '0')
}
