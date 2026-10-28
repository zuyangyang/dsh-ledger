/**
 * ledger_add: the only write entry point (DESIGN.md 7).
 *
 * One sentence in, one record out. The model splits and maps; this file does
 * the deterministic work: amounts, dates, book routing, settlement, category,
 * idempotency, receipts. Shop kinds reuse the same tool so there is exactly one
 * place that can write money.
 * @module dsh-ledger/tools/add
 */

import { resolveActor, resolveBook } from '../actors.js'
import { classify } from '../categories.js'
import { deriveDedupeKey, deriveRequestId, newTxId } from '../ids.js'
import { parseAmount } from '../parse/amount.js'
import { parseDate } from '../parse/date.js'
import { detectPaymentMethod, detectSettlement, inferKind } from '../parse/kind.js'
import { buildPreview, buildReceipt } from '../receipt.js'
import { shanghaiDate, shanghaiIso } from '../util.js'
import { summarizeDebt } from '../views/debt.js'
import { fail } from './shared.js'

const HOME_KINDS = new Set(['expense', 'income', 'refund', 'transfer', 'adjustment'])
const SHOP_KINDS = new Set(['sale', 'purchase', 'payment_in', 'payment_out', 'return', 'stocktake', 'draw', 'transfer', 'expense'])

/** The book a kind belongs to; `expense` is legal in both. */
export function bookForKind(kind) {
  if (HOME_KINDS.has(kind) && !SHOP_KINDS.has(kind)) return 'home'
  if (SHOP_KINDS.has(kind) && !HOME_KINDS.has(kind)) return 'shop'
  return null
}

export function createAddTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_add',
    description:
      'Record one entry. Works for the household book and the shop book: pass kind for business events '
      + '(sale 卖出, purchase 进货, payment_in 收到还款, payment_out 付货款, return 退货, stocktake 盘点, draw 从店里取走). '
      + 'Copy amount and any date words verbatim — the plugin parses them. '
      + 'For credit sales set paid="0" and name the customer. Never pass ids: they are derived. '
      + 'Returns the receipt to show the user and whether it was a duplicate.',
    parameters: {
      amount: { type: 'string', required: true, description: '金额原文，如 "32"、"三十二块"、"1万2"；盘点不写金额就传 "0"。' },
      kind: { type: 'string', description: 'expense|income|refund|transfer|adjustment 或 sale|purchase|payment_in|payment_out|return|stocktake|draw；省略时按线索推断。' },
      book: { type: 'string', description: 'home（家里）| shop（店里）；说了"店里/家里"就传，没说省略。' },
      date_expr: { type: 'string', description: '日期原文，如 "昨天"、"上周三"、"9月3日"；省略=今天。' },
      occurred_on: { type: 'string', description: '已经确定的 ISO 日期 YYYY-MM-DD（优先用 date_expr）。' },
      paid: { type: 'string', description: '实际收到/付出多少原文。赊账传 "0"，部分付传实际金额，全款省略。' },
      customer: { type: 'string', description: '客户名（赊账必填；散客传 "散客"）。' },
      supplier: { type: 'string', description: '供应商名（进货/付货款用）。' },
      channel: { type: 'string', description: 'retail 零售 | wholesale 批发 | internal 内部。' },
      payment_method: { type: 'string', description: 'wechat|alipay|cash|card；说了微信/现金就传。' },
      category_l1: { type: 'string', description: '一级类目 slug 候选（插件别名表可覆盖）。' },
      category_l2: { type: 'string', description: '二级类目 slug 候选。' },
      merchant: { type: 'string', description: '商户名（家庭账从原文抽取）。' },
      note: { type: 'string', description: '备注，通常取原文片段。' },
      tags: { type: 'array', items: { type: 'string' }, description: '横切标记，如 gift、advance。' },
      source_text: { type: 'string', description: '整条用户消息原文，用于去重、溯源与识别是谁发的。' },
      entered_by: { type: 'string', description: '录入人；通常不用传：插件会按 dsh-im 的账号名（Yang/Mei）、发送者昵称、发送者 id 依次识别。只有用户明确说这笔是谁记的才传。' },
      item_index: { type: 'integer', description: '该笔在同一条消息中的序号（从 0 起）。' },
      item_total: { type: 'integer', description: '这条消息一共切出几笔。' },
      allow_duplicate: { type: 'boolean', description: '用户确认"确实又记了一笔一样的"时传 true。' },
      dry_run: { type: 'boolean', description: '只预览不落库，等用户确认时用。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const config = runtime.config
      const now = runtime.now()
      const today = shanghaiDate(now)
      const sourceText = args.source_text || args.note || ''
      const text = [sourceText, args.note, args.merchant, args.customer, args.supplier].filter(Boolean).join(' ')

      const { actor, actorSource, imSource } = resolveActor({
        enteredBy: args.entered_by,
        sourceText: args.source_text,
        config,
        imAccountName: runtime.imAccountName,
      })
      // The book decides how ambiguous words read (退了 = refund at home, return
      // in the shop), so route the book first and infer the kind against it.
      const provisional = resolveBook({
        explicitBook: args.book,
        actor,
        store: runtime.store,
        config,
      })
      const kind = args.kind || pickKind(text, provisional.book)
      const kindBook = bookForKind(kind)
      const { book, bookSource } = resolveBook({
        explicitBook: args.book || kindBook,
        actor,
        store: runtime.store,
        config,
      })
      if (kindBook && kindBook !== book) {
        throw new Error(kind + ' 只能记在' + (kindBook === 'shop' ? '店里' : '家里') + '；要记在另一本账请先说明')
      }

      const amount = parseAmount(args.amount)
      if (kind === 'stocktake' && !amount.ok) {
        // A stocktake carries quantities, not money; record it with zero.
      } else if (!amount.ok) {
        fail(amount)
      }
      const amountMinor = amount.ok ? amount.minor : 0

      const date = args.date_expr || args.occurred_on
        ? parseDate(args.date_expr || args.occurred_on, { now, dayCutoffHour: config.dayCutoffHour })
        : { ok: true, date: today, source: 'inferred_today' }
      if (!date.ok) fail(date)

      const settlement = settle({ args, kind, amountMinor, text, config })
      const person = args.customer || args.supplier || null
      const warnings = []
      let status = args.dry_run ? 'draft' : 'confirmed'

      if (settlement.open && settlement.open > 0 && !person) {
        if (kind === 'sale' || kind === 'purchase') {
          warnings.push('这笔还没收到钱，是谁拿的？')
          if (!args.dry_run) status = 'draft'
        } else {
          throw new Error(kind === 'payment_in' ? '这是谁还的？' : '这是付给谁的？')
        }
      }
      if (args.kind && args.kind !== kind) warnings.push('按"' + kind + '"记的（原文线索更明确）')

      const category = classify({
        text,
        book,
        kind,
        l1: args.category_l1,
        l2: args.category_l2,
        aliases: runtime.store.meta?.aliases || {},
      })
      const categoryFinal = kind === 'purchase' ? null : category
      const customer = args.customer || (settlement.open && settlement.open > 0 && kind === 'sale' ? '散客' : null)
      const channel = args.channel || (kind === 'sale' ? guessChannel(text) : null)

      const provenance = provenanceFrom(exec, args, { sourceText, now })
      const requestId = deriveRequestId({
        sessionId: provenance.session_id,
        messageId: provenance.message_id,
        toolName: 'ledger_add',
        itemIndex: args.item_index,
        payloadHash: [
          book, kind, amountMinor, date.date, customer || '', args.supplier || '',
          settlement.paidMinor ?? '', (args.note || '').trim(),
        ].join('|'),
      })
      const dedupeKey = deriveDedupeKey({
        kind,
        amountMinor,
        occurredOn: date.date,
        merchant: args.merchant,
        customer,
        note: args.note,
      })

      const record = {
        id: newTxId(now),
        schema: 2,
        version: 1,
        kind,
        status,
        book,
        amount_minor: amountMinor,
        currency: 'CNY',
        occurred_on: date.date,
        date_source: normalizeDateSource(date.source),
        category: categoryFinal,
        merchant: args.merchant || null,
        customer,
        supplier: args.supplier || null,
        channel,
        paid_minor: settlement.paidMinor,
        settlement_source: settlement.source,
        payment_method: args.payment_method || detectPaymentMethod(text) || null,
        items: [],
        cost_source: null,
        note: args.note || '',
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 8) : [],
        original_tx_id: null,
        entered_by: actor,
        actor_source: actorSource,
        dedupe_key: dedupeKey,
        request_id: requestId,
        provenance,
        created_at: shanghaiIso(now),
        updated_at: shanghaiIso(now),
        voided_at: null,
        void_reason: null,
      }

      const duplicate = findRecentDuplicate(runtime.store, record, now)
      if (duplicate && !args.allow_duplicate) {
        warnings.unshift('10 分钟前刚记过一笔一样的（' + (duplicate.id) + '），要是重复了说「删掉一笔」')
      }

      const subject = customer || args.supplier || args.merchant || null
      if (args.dry_run) {
        return {
          dry_run: true,
          would_record: summarize(record),
          warnings,
          text: buildPreview({ record, subject, config }).join('\n'),
        }
      }

      const { written, duplicates } = runtime.persist([record])
      if (written.length === 0) {
        return {
          duplicate: true,
          existing: duplicates[0]?.id ?? null,
          text: '这笔刚才已经记过了，没有重复写',
        }
      }
      runtime.store.rememberBookForActor(actor, book)

      const balanceMinor = subject && (settlement.open ?? 0) > 0 || (kind === 'payment_in' || kind === 'payment_out')
        ? balanceFor(runtime, { subject, side: kind === 'purchase' || kind === 'payment_out' ? 'payable' : 'receivable', asOf: date.date })
        : null
      const monthTotal = monthTotalFor(runtime, { book, month: date.date.slice(0, 7), kind })
      const teachLast = shouldTeachLast(runtime, now)
      const lines = buildReceipt({
        record,
        subject,
        balanceMinor,
        monthTotalMinor: monthTotal.minor,
        monthTotalLabel: monthTotal.label,
        warnings,
        teachLast,
        config,
        today,
      })

      return {
        id: record.id,
        duplicate: false,
        occurred_on: record.occurred_on,
        kind: record.kind,
        book: record.book,
        amount_minor: record.amount_minor,
        paid_minor: record.paid_minor,
        status: record.status,
        customer: record.customer,
        entered_by: record.entered_by,
        category_l1: record.category?.l1 ?? null,
        warnings,
        text: lines.join('\n'),
      }
    },
  })
}

/**
 * Infer against the routed book first, then against the other book; the more
 * confident reading wins so "卖了480" from dad is a sale, not an expense.
 */
function pickKind(text, provisionalBook) {
  const primary = inferKind(text, { book: provisionalBook })
  const other = inferKind(text, { book: provisionalBook === 'shop' ? 'home' : 'shop' })
  return other.confidence > primary.confidence ? other.kind : primary.kind
}

/** Store the design's short enum, whatever the parser called it. */
const DATE_SOURCE_MAP = { explicit_absolute: 'explicit_abs' }

function normalizeDateSource(source) {
  return DATE_SOURCE_MAP[source] || source
}

function settle({ args, kind, amountMinor, text, config }) {
  if (!['sale', 'purchase', 'return'].includes(kind)) {
    return { paidMinor: amountMinor, open: 0, source: 'n/a' }
  }
  const hint = detectSettlement(text)
  if (args.paid !== undefined && args.paid !== null && String(args.paid).trim() !== '') {
    const paid = parsePaid(args.paid)
    return { paidMinor: paid, open: Math.max(0, amountMinor - paid), source: 'explicit' }
  }
  if (kind === 'purchase' && hint === null) {
    const credit = config.purchaseSettlementDefault === 'credit'
    return { paidMinor: credit ? 0 : amountMinor, open: credit ? amountMinor : 0, source: 'inferred_default' }
  }
  if (hint === 'credit') return { paidMinor: 0, open: amountMinor, source: 'explicit_credit' }
  return { paidMinor: amountMinor, open: 0, source: hint === 'cash' ? 'explicit_cash' : 'inferred_default' }
}

/**
 * A paid amount may legitimately be zero ("先欠着"), which parseAmount rejects
 * because a zero entry is not an entry.
 */
export function parsePaid(text) {
  const raw = String(text ?? '').trim()
  if (/^[0０]+([.．][0０]+)?\s*(元|块)?$/.test(raw)) return 0
  const parsed = parseAmount(raw)
  if (!parsed.ok) fail(parsed)
  return parsed.minor
}

function guessChannel(text) {
  if (/批发|批给|同行|走货/.test(text)) return 'wholesale'
  if (/自家|内部|自用/.test(text)) return 'internal'
  return 'retail'
}

function provenanceFrom(exec, args, { sourceText, now }) {
  const sessionId = exec?.session?.id ?? exec?.agent?.session?.id ?? exec?.sessionId ?? null
  const messageId = exec?.message?.id ?? exec?.messageId ?? exec?.turnId ?? null
  return {
    session_id: sessionId,
    message_id: messageId,
    item_index: Number.isInteger(args.item_index) ? args.item_index : null,
    source_text: typeof sourceText === 'string' ? sourceText.slice(0, 500) : '',
    parser: 'llm',
    recorded_at: shanghaiIso(now),
  }
}

function findRecentDuplicate(store, record, now) {
  const tenMinutes = 10 * 60 * 1000
  for (const candidate of store.all()) {
    if (candidate.id === record.id || candidate.status === 'void') continue
    if (candidate.dedupe_key !== record.dedupe_key) continue
    if ((candidate.entered_by || null) !== (record.entered_by || null)) continue
    const at = Date.parse(candidate.created_at || '')
    if (Number.isFinite(at) && now.getTime() - at <= tenMinutes) return candidate
  }
  return null
}

function balanceFor(runtime, { subject, side, asOf }) {
  if (!subject) return null
  try {
    const summary = summarizeDebt(runtime.store.all(), { side, asOf })
    const person = summary.people.find((row) => row.name === subject)
    return person ? person.open_minor : 0
  } catch {
    return null
  }
}

function monthTotalFor(runtime, { book, month, kind }) {
  const prefix = month + '-'
  const records = runtime.store.all().filter((record) =>
    record.book === book && record.status === 'confirmed' && record.occurred_on.startsWith(prefix))
  const sum = (kinds) => records.filter((record) => kinds.includes(record.kind))
    .reduce((total, record) => total + record.amount_minor, 0)
  if (book === 'shop') {
    const sales = sum(['sale'])
    return { minor: sales - sum(['return']), label: '本月卖出' }
  }
  if (kind === 'income') return { minor: sum(['income']), label: '本月收入' }
  return { minor: sum(['expense']) - sum(['refund']), label: '本月支出' }
}

function shouldTeachLast(runtime, now) {
  const meta = runtime.store.meta
  const last = Date.parse(meta.lastFixHintAt || '')
  if (Number.isFinite(last) && now.getTime() - last < 12 * 3600 * 1000) return false
  runtime.store.patchMeta({ lastFixHintAt: shanghaiIso(now) })
  return true
}

function summarize(record) {
  return {
    kind: record.kind,
    book: record.book,
    amount_minor: record.amount_minor,
    occurred_on: record.occurred_on,
    customer: record.customer,
    supplier: record.supplier,
    category_l1: record.category?.l1 ?? null,
    entered_by: record.entered_by,
  }
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition