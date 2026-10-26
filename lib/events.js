/**
 * The one record shape every book writes (DESIGN.md 4.1 / 4.6).
 * @module dsh-ledger/events
 */

export const SCHEMA_VERSION = 2

export const BOOKS = ['home', 'shop']

/** Every kind, grouped by what it touches. */
export const KINDS = [
  'expense',      // home spending, shop running costs
  'income',       // home income
  'refund',       // home refund (money back, not a negative expense)
  'transfer',     // moves money between books/accounts, never income
  'adjustment',   // opening balance or a deliberate correction
  'sale',         // shop retail / wholesale
  'purchase',     // shop stock-in
  'payment_in',   // customer pays down a receivable (NOT income)
  'payment_out',  // we pay a supplier down a payable
  'return',       // goods coming back (customer) or going back (supplier)
  'stocktake',    // counted quantities; the only quantity truth
  'draw',         // owner takes money or goods out of the shop
]

export const STATUSES = ['draft', 'confirmed', 'void']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isInt(value) {
  return Number.isInteger(value)
}

/**
 * Validate one line read from the journal. Returns {ok, reason}; a malformed
 * line is quarantined, never silently repaired.
 */
export function validateStoredRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'not-an-object' }
  if (typeof record.id !== 'string' || record.id.length === 0) return { ok: false, reason: 'missing-id' }
  if (!isInt(record.version) || record.version < 1) return { ok: false, reason: 'bad-version' }
  if (!KINDS.includes(record.kind)) return { ok: false, reason: 'bad-kind' }
  if (!BOOKS.includes(record.book)) return { ok: false, reason: 'bad-book' }
  if (!STATUSES.includes(record.status)) return { ok: false, reason: 'bad-status' }
  if (!isInt(record.amount_minor)) return { ok: false, reason: 'bad-amount' }
  if (typeof record.occurred_on !== 'string' || !DATE_RE.test(record.occurred_on)) return { ok: false, reason: 'bad-date' }
  return { ok: true }
}

/** True when this record contributes to any derived view. */
export function isLive(record) {
  return record.status === 'confirmed'
}

/** True when the record has money still open (receivable/payable source). */
export function openMinor(record, settledMinor = 0) {
  const paid = isInt(record.paid_minor) ? record.paid_minor : record.amount_minor
  return record.amount_minor - paid - settledMinor
}

/** Human label for the book tag used in receipts. */
export function bookLabel(book, config = {}) {
  if (book === 'shop') return config.shopName || '店里'
  return config.homeName || '家里'
}
