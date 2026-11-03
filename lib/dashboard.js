/**
 * The settings panel's payload (no DOM, no transport): one month of books as
 * numbers a dashboard can draw, plus enough context to tell whether the numbers
 * are trustworthy (where they came from, how fresh, anything quarantined).
 * @module dsh-ledger/dashboard
 */

import { summarizeMonth, summarizeShopCash } from './views/report.js'
import { summarizeDebt } from './views/debt.js'
import { labelOf } from './categories.js'
import { kindLabel } from './receipt.js'
import { shanghaiIso } from './util.js'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** The month a request means: its own argument, else the current one. */
export function resolveMonth(month, now = new Date()) {
  if (typeof month === 'string' && MONTH_RE.test(month)) return month
  return shanghaiIso(now).slice(0, 7)
}

/** Shift a YYYY-MM string by n months. */
export function shiftMonth(month, delta) {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1 + delta
  const carried = year * 12 + index
  const nextYear = Math.floor(carried / 12)
  const nextMonth = (carried % 12 + 12) % 12 + 1
  return String(nextYear) + '-' + String(nextMonth).padStart(2, '0')
}

/** The six months ending at `month`, oldest first. */
export function monthRange(month, count = 6) {
  const months = []
  for (let offset = count - 1; offset >= 0; offset -= 1) months.push(shiftMonth(month, -offset))
  return months
}

/**
 * One month of both books, ready to render.
 * @param {{records: object[], config: object, stats: object, git?: object, month?: string, now?: Date, recentLimit?: number}} input
 */
export function buildDashboard({
  records = [],
  config = {},
  stats = {},
  git = null,
  month,
  now = new Date(),
  recentLimit = 12,
} = {}) {
  const selected = resolveMonth(month, now)
  const asOf = lastDayOfMonth(selected)
  const home = summarizeMonth(records, { month: selected, book: 'home' })
  const shop = summarizeShopCash(records, { month: selected })
  const receivable = summarizeDebt(records, { side: 'receivable', asOf })
  const payable = summarizeDebt(records, { side: 'payable', asOf })

  return {
    generated_at: shanghaiIso(now),
    month: selected,
    months: monthRange(selected).map((entry) => ({
      month: entry,
      home_spent_minor: summarizeMonth(records, { month: entry, book: 'home' }).expense_minor,
      shop_sales_minor: summarizeShopCash(records, { month: entry }).sales_minor,
    })),
    storage: {
      data_dir: stats.dataDir ?? config.dataDir ?? null,
      is_default: config.dataDirIsDefault === true,
      default_data_dir: config.defaultDataDir ?? null,
      entries: stats.entries ?? 0,
      quarantined: stats.quarantined ?? 0,
      bytes: stats.bytes ?? 0,
      git_ready: git?.ready === true,
      git_enabled: git?.enabled !== false,
      git_error: git?.lastError ?? null,
      git_nested_in: git?.nestedRepo ?? null,
    },
    home: {
      month: selected,
      count: home.count,
      expense_minor: home.expense_minor,
      refund_minor: home.refund_minor,
      income_minor: home.income_minor,
      net_minor: home.net_minor,
      uncategorized_count: home.uncategorized_count,
      by_category: home.byCategory.map((row) => ({
        key: row.l1 ?? 'other',
        label: row.label || labelOf(row.l1) || '未归类',
        minor: row.amount_minor,
        share_bp: row.share_bp,
        count: row.count,
      })),
      by_day: home.byDay,
      biggest: home.biggest,
    },
    shop: {
      month: selected,
      sales_minor: shop.sales_minor,
      sales_count: shop.sales_count,
      retail_minor: shop.retail_minor,
      wholesale_minor: shop.wholesale_minor,
      cash_in_minor: shop.cash_in_minor,
      cash_out_minor: shop.cash_out_minor,
      cash_net_minor: shop.cash_net_minor,
      purchase_total_minor: shop.purchase_total_minor,
      purchase_paid_minor: shop.purchase_paid_minor,
      expense_minor: shop.expense_minor,
    },
    receivable: debtView(receivable),
    payable: debtView(payable),
    recent: recentEntries(records, recentLimit),
    config: {
      data_dir: config.dataDir ?? null,
      shop_name: config.shopName ?? '店里',
      default_book: config.defaultBook ?? 'home',
      auto_commit: config.autoCommit !== false,
      purchase_settlement_default: config.purchaseSettlementDefault ?? 'cash',
    },
  }
}

function debtView(summary) {
  return {
    total_minor: summary.total_minor,
    people_count: summary.people_count,
    people: summary.people.slice(0, 12).map((row) => ({
      name: row.name,
      open_minor: row.open_minor,
      age_days: row.age_days ?? null,
      oldest_on: row.oldest_on ?? null,
      items: row.items ?? 0,
    })),
    scattered_minor: summary.scattered_minor ?? 0,
  }
}

/** Newest first, for the panel's list. */
function recentEntries(records, limit) {
  return [...records]
    .filter((record) => record.status !== 'void')
    .sort((a, b) => {
      if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? 1 : -1
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
      return a.id < b.id ? 1 : -1
    })
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      date: record.occurred_on,
      book: record.book,
      kind: record.kind,
      kind_label: kindLabel(record.kind),
      amount_minor: record.amount_minor,
      paid_minor: Number.isInteger(record.paid_minor) ? record.paid_minor : record.amount_minor,
      category_label: record.category?.l1 ? labelOf(record.category.l1) : null,
      counterparty: record.customer || record.supplier || record.merchant || null,
      note: record.note || '',
      entered_by: record.entered_by || null,
      status: record.status,
    }))
}

function lastDayOfMonth(month) {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  return month + '-' + String(new Date(Date.UTC(year, index, 0)).getUTCDate()).padStart(2, '0')
}