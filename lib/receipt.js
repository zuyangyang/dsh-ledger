/**
 * Receipts are the only thing most users read, so they are written to a budget:
 * four lines at most, no English, no ids, no status words, always the book tag,
 * and always the running balance of the person involved (DESIGN.md 18.5).
 * @module dsh-ledger/receipt
 */

import { daysBetween, formatMoney, shanghaiDate } from './util.js'

const KIND_LABELS = {
  expense: '支出',
  income: '收入',
  refund: '退款',
  transfer: '转账',
  adjustment: '调整',
  sale: '卖出',
  purchase: '进货',
  payment_in: '收到还款',
  payment_out: '付了货款',
  return: '退货',
  stocktake: '盘点',
  draw: '取走',
}

/** "支出" / "卖出" ... */
export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind
}

/** Today-like dates read as words, not digits. */
export function humanDate(dateStr, today = shanghaiDate()) {
  if (dateStr === today) return '今天'
  const back = daysBetween(dateStr, today)
  if (back === 1) return '昨天'
  if (back === 2) return '前天'
  const [, month, day] = dateStr.split('-')
  return Number(month) + ' 月 ' + Number(day) + ' 号'
}

/** The book tag every receipt carries. */
export function bookTag(book, config = {}) {
  return '[' + (book === 'shop' ? (config.shopName || '店里') : '家里') + ']'
}

/**
 * Build the receipt lines for a freshly written record.
 * @param {object} input
 * @param {object} input.record
 * @param {string} [input.subject]   who/what this entry is about
 * @param {number|null} [input.balanceMinor] remaining receivable/payable for the subject
 * @param {number|null} [input.monthTotalMinor] this book's expense (or sales) total this month
 * @param {string[]} [input.warnings]
 * @param {boolean} [input.teachLast] include the one-time "改最后那笔" hint
 * @param {object} [input.config]
 * @param {string} [input.today]
 */
export function buildReceipt({
  record,
  subject = null,
  balanceMinor = null,
  monthTotalMinor = null,
  monthTotalLabel = null,
  warnings = [],
  teachLast = false,
  config = {},
  today = shanghaiDate(),
}) {
  const lines = []
  const amount = formatMoney(Math.abs(record.amount_minor))
  const when = humanDate(record.occurred_on, today)
  const tag = bookTag(record.book, config)
  const kind = kindLabel(record.kind)

  let head = '已记 · ' + when + ' ' + kind + ' ' + amount
  if (subject) head += '（' + subject + '）'
  head += ' ' + tag
  lines.push(head)

  if (balanceMinor !== null && balanceMinor !== undefined) {
    const label = record.kind === 'purchase' || record.kind === 'payment_out' ? '还欠他' : '还欠'
    lines.push(label + ' ' + formatMoney(balanceMinor) + (subject ? '（' + subject + '）' : ''))
  } else if (monthTotalMinor !== null && monthTotalMinor !== undefined) {
    lines.push((monthTotalLabel || '本月') + ' ' + formatMoney(monthTotalMinor))
  }

  for (const warning of warnings.slice(0, 2)) lines.push(warning)
  if (teachLast) lines.push('记错了就说「最后那笔改成…」，不用重说整句')
  return lines.slice(0, 4)
}

/** Receipt text for a dry run: nothing was written, say so plainly. */
export function buildPreview({ record, subject = null, config = {} }) {
  const tag = bookTag(record.book, config)
  const head = '要记成 · ' + humanDate(record.occurred_on) + ' ' + kindLabel(record.kind) + ' ' +
    formatMoney(Math.abs(record.amount_minor)) + (subject ? '（' + subject + '）' : '') + ' ' + tag
  return [head, '还没写进去；说「就这样记」才落库']
}

/** Receipt for a correction: always show before -> after. */
export function buildFixReceipt({ before, after, subject = null, balanceMinor = null, config = {} }) {
  const lines = []
  if (after.status === 'void' && before.status !== 'void') {
    lines.push('删了 · ' + humanDate(before.occurred_on) + ' ' + kindLabel(before.kind) + ' ' +
      formatMoney(Math.abs(before.amount_minor)) + (subject ? '（' + subject + '）' : '') + ' ' + bookTag(before.book, config))
  } else if (before.status === 'void' && after.status !== 'void') {
    lines.push('恢复了 · ' + humanDate(after.occurred_on) + ' ' + kindLabel(after.kind) + ' ' +
      formatMoney(Math.abs(after.amount_minor)) + (subject ? '（' + subject + '）' : '') + ' ' + bookTag(after.book, config))
  } else if (before.book !== after.book) {
    lines.push('换了账本 · ' + bookTag(before.book, config) + ' → ' + bookTag(after.book, config))
  } else if (before.amount_minor !== after.amount_minor) {
    lines.push('改了 · ' + formatMoney(Math.abs(before.amount_minor)) + ' → ' + formatMoney(Math.abs(after.amount_minor)) +
      (subject ? '（' + subject + '）' : ''))
  } else {
    lines.push('改好了 · ' + humanDate(after.occurred_on) + ' ' + kindLabel(after.kind) + ' ' +
      formatMoney(Math.abs(after.amount_minor)) + (subject ? '（' + subject + '）' : '') + ' ' + bookTag(after.book, config))
  }
  if (balanceMinor !== null && balanceMinor !== undefined && subject) {
    lines.push(subject + (after.kind === 'purchase' || after.kind === 'payment_out' ? ' 欠他 ' : ' 还欠 ') + formatMoney(balanceMinor))
  }
  return lines.slice(0, 4)
}
