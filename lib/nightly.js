/**
 * The nightly summary: one quiet line at 21:30, not a report to read (DESIGN.md 11).
 *
 * The plugin computes the text and hands it to the caller, which is responsible
 * for delivering it to a live agent. Everything is idempotent per (date, book):
 * a restart at 21:31 must not send twice.
 * @module dsh-ledger/nightly
 */

import { labelOf } from './categories.js'
import { formatMoney, shanghaiDate } from './util.js'

export function nightlyKey(date, book) {
  return date + '|' + book
}

/** Should the 21:30 pass run now? */
export function isDue({ now = new Date(), config, meta }) {
  if (!config.nightlyEnabled) return false
  const time = shanghaiDateTime(now)
  if (time.date + ' ' + time.hhmm < time.date + ' ' + config.nightlyTime) return false
  const sent = meta?.nightly?.sent || {}
  const keys = [nightlyKey(time.date, 'home'), nightlyKey(time.date, 'shop')]
  return keys.some((key) => !sent[key])
}

/** Build (and remember) the summaries that are still unsent for this date. */
export function buildNightly({ runtime, now = runtime.now() }) {
  const config = runtime.config
  const time = shanghaiDateTime(now)
  const records = runtime.store.all().filter((record) => record.status === 'confirmed')
  const messages = []
  const sent = { ...(runtime.store.meta.nightly?.sent || {}) }

  for (const book of ['home', 'shop']) {
    if (book === 'shop' && !config.nightlyShopDaily) continue
    if (book === 'home' && !config.nightlyHomeWeekly) continue
    const key = nightlyKey(time.date, book)
    if (sent[key]) continue
    if (book === 'home' && !isWeeklyDay(now, config.nightlyHomeWeekly)) continue
    const rows = records.filter((record) => record.book === book && record.occurred_on === time.date)
    if (rows.length === 0) {
      sent[key] = shanghaiInstant(now)
      continue
    }
    messages.push(book === 'shop' ? shopLine(rows, time.date) : homeLine(rows, time.date))
    sent[key] = shanghaiInstant(now)
  }

  if (messages.length > 0) {
    runtime.store.patchMeta({ nightly: { ...(runtime.store.meta.nightly || {}), sent } })
  } else if (Object.keys(sent).length > 0) {
    const known = runtime.store.meta.nightly?.sent || {}
    const changed = Object.keys(sent).some((key) => sent[key] !== known[key])
    if (changed) runtime.store.patchMeta({ nightly: { ...(runtime.store.meta.nightly || {}), sent } })
  }
  return { messages, date: time.date }
}

function homeLine(rows, date) {
  const spent = rows.filter((row) => row.kind === 'expense').reduce((sum, row) => sum + row.amount_minor, 0)
  const income = rows.filter((row) => row.kind === 'income').reduce((sum, row) => sum + row.amount_minor, 0)
  const top = topCategory(rows)
  const parts = ['今天家里']
  if (spent > 0) parts.push('花了 ' + formatMoney(spent))
  if (income > 0) parts.push('进了 ' + formatMoney(income))
  if (top) parts.push('主要是' + top)
  parts.push(rows.length + ' 笔')
  return parts.join('，') + '。'
}

function shopLine(rows, date) {
  const sales = rows.filter((row) => row.kind === 'sale').reduce((sum, row) => sum + row.amount_minor, 0)
  const paid = rows.filter((row) => row.kind === 'sale').reduce((sum, row) => sum + (Number.isInteger(row.paid_minor) ? row.paid_minor : row.amount_minor), 0)
  const open = sales - paid
  const outgoing = rows.filter((row) => ['purchase', 'expense', 'payment_out'].includes(row.kind))
    .reduce((sum, row) => sum + (Number.isInteger(row.paid_minor) ? row.paid_minor : row.amount_minor), 0)
  const parts = ['今天店里卖了 ' + formatMoney(sales) + '（收到 ' + formatMoney(paid) + '）']
  if (open > 0) parts.push('赊出去 ' + formatMoney(open))
  if (outgoing > 0) parts.push('付出 ' + formatMoney(outgoing))
  if (rows.length === 0) parts.push('没记东西')
  return parts.join('，') + '，共 ' + rows.length + ' 笔。'
}

function topCategory(rows) {
  const byCategory = new Map()
  for (const row of rows) {
    if (row.kind !== 'expense') continue
    const key = row.category?.l1 || 'other'
    byCategory.set(key, (byCategory.get(key) || 0) + row.amount_minor)
  }
  let best = null
  for (const [key, amount] of byCategory) {
    if (!best || amount > best.amount) best = { key, amount }
  }
  return best ? labelOf(best.key) : ''
}

function isWeeklyDay(now, weekday) {
  const local = new Date(now.getTime() + 8 * 3600 * 1000)
  return local.getUTCDay() === (Number(weekday) || 0)
}

export function shanghaiDateTime(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()),
    hhmm: p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()),
  }
}

function shanghaiInstant(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'
}
