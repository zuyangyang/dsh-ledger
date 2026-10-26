/**
 * Small helpers shared by tool bodies: parsing guards, record filters, and the
 * "human error" convention (a thrown Error's message is what the user sees).
 * @module dsh-ledger/tools/shared
 */

import { isLive } from '../events.js'
import { compareRecords, formatMoney, shanghaiDate } from '../util.js'

/** Turn a parser failure into the message a person should read. */
export function fail(result) {
  throw new Error(result?.message || '没看懂这句话，换个说法再试一次')
}

/** Filter to one book unless "all" was asked for. */
export function inBook(records, book) {
  if (!book || book === 'all') return records
  return records.filter((record) => record.book === book)
}

/** Keep records whose occurred_on falls in a month (YYYY-MM) or a closed range. */
export function inPeriod(records, { month, from, to } = {}) {
  if (month) {
    const prefix = month + '-'
    return records.filter((record) => record.occurred_on.startsWith(prefix))
  }
  return records.filter((record) => {
    if (from && record.occurred_on < from) return false
    if (to && record.occurred_on > to) return false
    return true
  })
}

/** Live records only unless the caller wants drafts/voids too. */
export function liveOnly(records) {
  return records.filter(isLive)
}

/** Newest first, for "show me the last few" reads. */
export function newestFirst(records) {
  return [...records].sort((a, b) => compareRecords(b, a))
}

/** The record a bare "最后那笔" means: the most recently written live entry. */
export function lastWritten(records) {
  const live = records.filter((record) => record.status !== 'void')
  if (live.length === 0) return null
  return live.reduce((best, record) => (compareRecords(record, best) > 0 ? record : best))
}

/** "¥32.00" */
export function money(minor) {
  return formatMoney(minor)
}

/** Today in Asia/Shanghai. */
export function today() {
  return shanghaiDate()
}

/** One-line description of a record for listings and receipts. */
export function describeRecord(record, config = {}) {
  const when = record.occurred_on
  const who = record.customer || record.supplier || record.merchant || ''
  const tag = record.book === 'shop' ? (config.shopName || '店里') : '家里'
  const parts = [when, kindText(record.kind), money(Math.abs(record.amount_minor)), tag]
  if (who) parts.push(who)
  if (record.note) parts.push(record.note)
  if (record.status === 'void') parts.push('已作废')
  if (record.status === 'draft') parts.push('待确认')
  return parts.join(' · ')
}

const KIND_TEXT = {
  expense: '支出', income: '收入', refund: '退款', transfer: '转账', adjustment: '调整',
  sale: '卖出', purchase: '进货', payment_in: '收还款', payment_out: '付货款',
  return: '退货', stocktake: '盘点', draw: '取走',
}

export function kindText(kind) {
  return KIND_TEXT[kind] || kind
}
