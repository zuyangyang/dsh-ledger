/**
 * Receivables and payables (DESIGN.md 4.7 / 8.8).
 *
 * The only source of truth for "who owes whom" is the journal: an open amount is
 * `amount − paid − Σ settled`, and settlements are allocated FIFO to the oldest
 * open item for that person. Nothing here is stored, so a correction anywhere
 * immediately changes the answer.
 * @module dsh-ledger/views/debt
 */

import { compareRecords, daysBetween, formatMoney, shanghaiDate } from '../util.js'

const SIDES = {
  receivable: { itemKind: 'sale', payKind: 'payment_in', partyField: 'customer', title: '外面还欠我' },
  payable: { itemKind: 'purchase', payKind: 'payment_out', partyField: 'supplier', title: '我欠外面' },
}

const SCATTERED = new Set(['散客', '散', '路人'])

/** Age buckets, in days, upper bound exclusive. */
export function bucketOf(ageDays) {
  if (ageDays <= 30) return 'd0_30'
  if (ageDays <= 60) return 'd31_60'
  if (ageDays <= 90) return 'd61_90'
  return 'd90p'
}

function isScattered(name) {
  return SCATTERED.has(String(name || '').trim())
}

/**
 * Walk the journal in total order and keep a FIFO queue of open items per
 * person. Returns the per-person state before formatting.
 * @param {object[]} records
 * @param {{side?: 'receivable'|'payable', asOf?: string}} options
 */
export function partyLedger(records, { side = 'receivable', asOf } = {}) {
  const spec = SIDES[side]
  if (!spec) throw new Error('未知的欠款方向：' + side)
  const cutoff = asOf || shanghaiDate()
  const ordered = [...records]
    .filter((record) => record.status === 'confirmed' && record.occurred_on <= cutoff)
    .sort(compareRecords)

  const people = new Map()
  const ensure = (name) => {
    const key = String(name || '').trim()
    if (!key) return null
    let state = people.get(key)
    if (!state) {
      state = { name: key, items: [], last: null, scattered: isScattered(key) }
      people.set(key, state)
    }
    return state
  }

  for (const record of ordered) {
    const name = record[spec.partyField]
    const state = ensure(name)
    if (!state) continue
    if (record.kind === spec.itemKind) {
      const paid = Number.isInteger(record.paid_minor) ? record.paid_minor : record.amount_minor
      const open = record.amount_minor - paid
      if (open > 0) {
        state.items.push({
          id: record.id,
          occurred_on: record.occurred_on,
          created_at: record.created_at || '',
          remaining: open,
          note: record.note || '',
        })
      }
      state.last = record
    } else if (record.kind === spec.payKind || record.kind === 'return') {
      let available = record.amount_minor
      while (available > 0 && state.items.length > 0) {
        const oldest = state.items[0]
        const take = Math.min(available, oldest.remaining)
        oldest.remaining -= take
        available -= take
        if (oldest.remaining === 0) state.items.shift()
      }
      // A payment larger than the debt is money in advance; it is not a
      // receivable, so it is dropped rather than turned into a negative number.
      state.last = record
    }
  }

  const rows = []
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 }
  let scatteredMinor = 0
  for (const state of people.values()) {
    if (state.items.length === 0) continue
    const open = state.items.reduce((total, item) => total + item.remaining, 0)
    const oldest = state.items[0]
    const age = Math.max(0, daysBetween(oldest.occurred_on, cutoff))
    if (state.scattered) {
      scatteredMinor += open
      continue
    }
    for (const item of state.items) {
      buckets[bucketOf(Math.max(0, daysBetween(item.occurred_on, cutoff)))] += item.remaining
    }
    rows.push({
      name: state.name,
      open_minor: open,
      oldest_on: oldest.occurred_on,
      age_days: age,
      bucket: bucketOf(age),
      items: state.items.length,
      last: state.last
        ? { occurred_on: state.last.occurred_on, kind: state.last.kind, amount_minor: state.last.amount_minor, note: state.last.note || '' }
        : null,
    })
  }
  rows.sort((a, b) => b.open_minor - a.open_minor || b.age_days - a.age_days || a.name.localeCompare(b.name))
  return { side, asOf: cutoff, rows, buckets, scatteredMinor }
}

/** Receivable or payable summary as the tools and reports consume it. */
export function summarizeDebt(records, { side = 'receivable', asOf } = {}) {
  const ledger = partyLedger(records, { side, asOf })
  const total = ledger.rows.reduce((sum, row) => sum + row.open_minor, 0)
  return {
    side,
    asOf: ledger.asOf,
    title: SIDES[side].title,
    total_minor: total,
    people_count: ledger.rows.length,
    people: ledger.rows,
    buckets: ledger.buckets,
    scattered_minor: ledger.scatteredMinor,
  }
}

/** Debt table as markdown: oldest first, over-30-days flagged. */
export function renderDebtReport(summary) {
  const lines = ['## ' + summary.title + '（截至 ' + summary.asOf + '）']
  if (summary.people.length === 0) {
    lines.push('')
    lines.push('没有人欠着，干净。')
    if (summary.scattered_minor > 0) lines.push('（散客还欠 ¥' + (summary.scattered_minor / 100).toFixed(2) + '，不记在谁头上）')
    return lines.join('\n')
  }
  lines.push('')
  lines.push('合计 ' + formatMoney(summary.total_minor) + '，' + summary.people.length + ' 个人')
  lines.push('')
  lines.push('| 人 | 欠款 | 最早 | 天数 | 最近一笔 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const person of summary.people) {
    const flag = person.age_days > 30 ? ' ⚠️' : ''
    const last = person.last
      ? person.last.occurred_on + ' ' + kindText(person.last.kind) + ' ' + formatMoney(person.last.amount_minor)
      : '—'
    lines.push('| ' + person.name + flag + ' | ' + formatMoney(person.open_minor) + ' | ' + person.oldest_on + ' | ' + person.age_days + ' | ' + last + ' |')
  }
  const oldest = summary.people[0]
  if (oldest && oldest.age_days > 30) {
    lines.push('')
    lines.push('最久的是 ' + oldest.name + '（' + oldest.age_days + ' 天），可以打个电话问问。')
  }
  if (summary.scattered_minor > 0) {
    lines.push('')
    lines.push('另外散客还欠 ¥' + (summary.scattered_minor / 100).toFixed(2) + '，不记在谁头上。')
  }
  lineKindText()
  return lines.join('\n')
}

const KIND_TEXT = {
  sale: '卖', purchase: '进', payment_in: '还', payment_out: '付', return: '退', expense: '支出',
}

function kindText(kind) {
  return KIND_TEXT[kind] || kind
}

function lineKindText() {}
