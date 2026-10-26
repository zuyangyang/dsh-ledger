/**
 * Direction / kind inference from the user's own words (DESIGN.md 5.7 and 5.4).
 *
 * The model is supposed to pass `kind` plus an evidence quote; this module is
 * the deterministic fallback for when it does not, and the tie-breaker when the
 * quote is thin. Rules are book-scoped: the shop's "退了" is a `return`, the
 * household's "退了" is a `refund`, and no amount of pattern matching can tell
 * those apart without knowing the book.
 *
 * Pure: no clock, no I/O. Errors are not thrown; the worst case is a
 * low-confidence `expense` with a reason saying no clue matched.
 * @module dsh-ledger/parse/kind
 */

import { KINDS } from '../events.js'

/**
 * One rule per strong clue, strongest first. "Short sentence, strongest clue"
 * (5.7): the first rule that matches wins, so a single 卖了 beats a trailing
 * 现金 rather than totting up signals.
 * @typedef {{
 *   re: RegExp, kind: string, confidence: number, reason: string,
 * }} KindRule
 */

/** @type {KindRule[]} book=shop rules, strongest clue first. */
const SHOP_RULES = [
  { re: /盘点|数了一下|数了数|实际还剩|库存还/, kind: 'stocktake', confidence: 0.95, reason: '盘点/数数 → stocktake（只记数量）' },
  { re: /从店里拿|从店拿|拿回家|带回家|自己穿了|自己穿|自己留|送人了|送人/, kind: 'draw', confidence: 0.92, reason: '从店里拿走 → draw' },
  { re: /退了|退回来|退回|说不合适|换了一双|换货|退给厂|退回厂/, kind: 'return', confidence: 0.9, reason: '退货 → return' },
  { re: /我付了|付给|付清了?|结账了|结算了|给厂家|给供应商/, kind: 'payment_out', confidence: 0.88, reason: '付给供应商 → payment_out' },
  { re: /进货|进了|上了|厂家发|老王那儿|进了一批/, kind: 'purchase', confidence: 0.88, reason: '进货 → purchase' },
  { re: /还了|还钱|打过来|转账给我|给了|还回来/, kind: 'payment_in', confidence: 0.85, reason: '客户还钱 → payment_in（不是收入）' },
  { re: /卖|零售|批发|批|出货|拿货|收了多少|拿(?:了)?\s*[0-9一二三四五六七八九十百千万两]+\s*(?:双|件|个|箱|包|套)/, kind: 'sale', confidence: 0.9, reason: '卖出 → sale' },
]

/** @type {KindRule[]} book=home rules, strongest clue first. */
const HOME_RULES = [
  { re: /信用卡.*(?:到账|还款)|还信用卡|还卡账|还款.*信用卡/, kind: 'transfer', confidence: 0.95, reason: '信用卡还款/到账 → transfer（5.4 例外）' },
  { re: /转到|转入|转出|转给|转账|充值|提现|取现/, kind: 'transfer', confidence: 0.88, reason: '转账 → transfer（不计收支）' },
  { re: /退款|退我|退回来|还回来|退了|退给|退回/, kind: 'refund', confidence: 0.88, reason: '退款 → refund' },
  { re: /到账|工资|发薪|发工资|收入|进账|报销到账|报下来|奖金|利息|分红|红包收入/, kind: 'income', confidence: 0.88, reason: '收入线索 → income' },
]

/** Settlement words that mean "not paid yet". Credit wins over cash. */
const CREDIT_SETTLEMENT_RE = /先欠着|欠着|欠账|欠我|欠款|还欠|欠|月底结|过几天给|过几天还|回头给|改天给|下次给|先记着|记账上|没给钱|还没给|赊/

/** Settlement words that mean "paid on the spot". */
const CASH_SETTLEMENT_RE = /现金|现钱|现结|现付|当场|付清了?|付了|给了|扫码|微信付|支付宝付|刷卡/

/** Payment instruments, most specific first. */
const PAYMENT_METHOD_RULES = [
  { re: /微信|wechat|威信|wx/i, method: 'wechat' },
  { re: /支付宝|alipay|花呗|余额宝/i, method: 'alipay' },
  { re: /信用卡|银行卡|储蓄卡|刷卡|卡付|pos机|pos/i, method: 'card' },
  { re: /现金|现钱|现钞|付现/, method: 'cash' },
]

function normalizeText(text) {
  return typeof text === 'string' ? text : ''
}

/**
 * Infer the kind of one entry from its text.
 *
 * Rules are scoped by book (DESIGN 5.7): `book: 'shop'` uses the business
 * clues (卖/批发/进货/还了/盘点/从店里拿…), anything else uses the household
 * clues (到账/工资/退款/转账…). Defaults to `expense` at low confidence —
 * the caller decides whether that needs a follow-up question.
 *
 * @param {string} text user words for one entry
 * @param {{book?: 'home'|'shop'}} [options]
 * @returns {{kind: string, confidence: number, reason: string}}
 *   `kind` is always one of events.js KINDS.
 */
export function inferKind(text, { book = 'home' } = {}) {
  const source = normalizeText(text)
  const rules = book === 'shop' ? SHOP_RULES : HOME_RULES
  for (const rule of rules) {
    if (rule.re.test(source)) {
      return { kind: rule.kind, confidence: rule.confidence, reason: rule.reason }
    }
  }
  return {
    kind: 'expense',
    confidence: 0.6,
    reason: book === 'shop' ? '没有更强的线索，按店里开支记' : '没有更强的线索，按支出记',
  }
}

/**
 * Did the user say whether this was paid now or left owing?
 * Credit wins when both appear ("先给了200，剩下的月底结" is still credit).
 * @param {string} text user words
 * @returns {'credit'|'cash'|null} null when settlement was never mentioned
 */
export function detectSettlement(text) {
  const source = normalizeText(text)
  if (CREDIT_SETTLEMENT_RE.test(source)) return 'credit'
  if (CASH_SETTLEMENT_RE.test(source)) return 'cash'
  return null
}

/**
 * Which instrument did the user mention? Null when they did not say — never
 * default to wechat, because the cash drawer has to reconcile (DESIGN 8.7).
 * @param {string} text user words
 * @returns {'wechat'|'alipay'|'cash'|'card'|null}
 */
export function detectPaymentMethod(text) {
  const source = normalizeText(text)
  for (const rule of PAYMENT_METHOD_RULES) {
    if (rule.re.test(source)) return rule.method
  }
  return null
}

/** Kinds this module may return, re-exported for callers that validate. */
export const PARSE_KINDS = KINDS.slice()
