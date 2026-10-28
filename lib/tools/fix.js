/**
 * ledger_fix: correct, void, restore, confirm or move one entry (DESIGN.md 10).
 *
 * People do not say "change entry 3"; they say "the last one". So `match.pick =
 * "last"` is the primary selector, and every change reports before -> after
 * plus the affected person's balance.
 * @module dsh-ledger/tools/fix
 */

import { deriveDedupeKey } from '../ids.js'
import { parseAmount } from '../parse/amount.js'
import { parseDate } from '../parse/date.js'
import { buildFixReceipt } from '../receipt.js'
import { resolveActor } from '../actors.js'
import { parsePaid } from './add.js'
import { fail, inBook, lastWritten, money } from './shared.js'

const ACTIONS = ['void', 'restore', 'confirm', 'unconfirm', 'move_book']

export function createFixTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_fix',
    description:
      'Correct one recorded entry: change amount/date/note/person, void it, restore it, confirm a draft, or move it to the other book. '
      + 'Use match.pick="last" when the user says "the last one" / "最后那笔" — do not ask for an id. '
      + 'Returns before and after, plus the balance of the person involved.',
    parameters: {
      target_id: { type: 'string', description: '要改的那条的 id（用户没提就省略）。' },
      match_pick: { type: 'string', description: '用指代找人：用户说"最后那笔/刚记的"就传 "last"；给了 target_id 则忽略。' },
      match_book: { type: 'string', description: '限定账本 home | shop（配合 match_pick）。' },
      match_entered_by: { type: 'string', description: '限定是谁记的（配合 match_pick）。' },
      patch_amount: { type: 'string', description: '新的金额原文，如 "680"。' },
      patch_occurred_on: { type: 'string', description: '新的日期 YYYY-MM-DD。' },
      patch_category_l1: { type: 'string', description: '新的一级类目 slug。' },
      patch_category_l2: { type: 'string', description: '新的二级类目 slug。' },
      patch_merchant: { type: 'string', description: '新的商户名。' },
      patch_note: { type: 'string', description: '新的备注。' },
      patch_customer: { type: 'string', description: '新的客户名。' },
      patch_supplier: { type: 'string', description: '新的供应商名。' },
      patch_paid: { type: 'string', description: '新的已收/已付金额原文（"0" 表示改回全欠）。' },
      action: { type: 'string', description: 'void 作废 | restore 恢复 | confirm 确认 | unconfirm 退回待确认 | move_book 换账本。' },
      book: { type: 'string', description: 'move_book 时的目标账本 home | shop。' },
      expected_version: { type: 'integer', description: '并发保护：目标当前版本号，不确定就省略。' },
      source_text: { type: 'string', description: '整条用户消息原文（用于识别是谁发的）。' },
      entered_by: { type: 'string', description: '录入人；通常不用传：插件会按 dsh-im 的账号名（Yang/Mei）、发送者昵称、发送者 id 依次识别。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args) {
      const config = runtime.config
      const records = runtime.store.all()
      const target = pickTarget(records, args, config)
      if (!target) throw new Error('没找到要改的那笔；说说大概是哪天、多少钱，我先查一下')

      const patch = {}
      const warnings = []
      if (args.patch_amount !== undefined) {
        const parsed = parseAmount(args.patch_amount)
        if (!parsed.ok) fail(parsed)
        patch.amount_minor = parsed.minor
      }
      if (args.patch_paid !== undefined) {
        patch.paid_minor = parsePaid(args.patch_paid)
        patch.settlement_source = 'corrected'
      }
      if (args.patch_occurred_on !== undefined) {
        const parsed = parseDate(args.patch_occurred_on, { now: runtime.now(), dayCutoffHour: config.dayCutoffHour })
        if (!parsed.ok) fail(parsed)
        patch.occurred_on = parsed.date
        patch.date_source = parsed.source === 'explicit_absolute' ? 'explicit_abs' : parsed.source
      }
      if (args.patch_category_l1 !== undefined || args.patch_category_l2 !== undefined) {
        patch.category = {
          ...(target.category || {}),
          ...(args.patch_category_l1 !== undefined ? { l1: args.patch_category_l1 } : {}),
          ...(args.patch_category_l2 !== undefined ? { l2: args.patch_category_l2 } : {}),
          source: 'manual',
        }
      }
      if (args.patch_merchant !== undefined) patch.merchant = args.patch_merchant
      if (args.patch_note !== undefined) patch.note = args.patch_note
      if (args.patch_customer !== undefined) patch.customer = args.patch_customer
      if (args.patch_supplier !== undefined) patch.supplier = args.patch_supplier

      if (args.action && !ACTIONS.includes(args.action)) throw new Error('不支持的改法：' + args.action)
      if (args.action === 'void') {
        patch.status = 'void'
        patch.voided_at = runtime.now().toISOString()
        patch.void_reason = args.patch_note || '用户要求作废'
      } else if (args.action === 'restore') {
        patch.status = 'confirmed'
        patch.voided_at = null
        patch.void_reason = null
      } else if (args.action === 'confirm') {
        patch.status = 'confirmed'
      } else if (args.action === 'unconfirm') {
        patch.status = 'draft'
      } else if (args.action === 'move_book') {
        if (args.book !== 'home' && args.book !== 'shop') throw new Error('换账本要说明是 家里 还是 店里')
        patch.book = args.book
      }

      if (Object.keys(patch).length === 0) throw new Error('没说改什么；说「最后那笔改成680」这样就行')

      const merged = { ...target, ...patch }
      patch.dedupe_key = deriveDedupeKey({
        kind: merged.kind,
        amountMinor: merged.amount_minor,
        occurredOn: merged.occurred_on,
        merchant: merged.merchant,
        customer: merged.customer,
        note: merged.note,
      })

      const { actor } = resolveActor({ enteredBy: args.entered_by, sourceText: args.source_text, config, imAccountName: runtime.imAccountName })
      if (actor) patch.edited_by = actor

      const { before, after } = runtime.revise(target.id, patch, { expectedVersion: args.expected_version })
      const lines = buildFixReceipt({ before, after, subject: after.customer || after.supplier || null, config })
      if (warnings.length > 0) lines.push(...warnings)

      return {
        id: after.id,
        version: after.version,
        before: { amount_minor: before.amount_minor, status: before.status, book: before.book, occurred_on: before.occurred_on },
        after: { amount_minor: after.amount_minor, status: after.status, book: after.book, occurred_on: after.occurred_on },
        text: lines.join('\n'),
      }
    },
  })
}

function pickTarget(records, args, config) {
  if (args.target_id) return records.find((record) => record.id === args.target_id) ?? null
  const pick = args.match_pick
  if (!pick) return null
  if (pick !== 'last') throw new Error('只支持「最后那笔」这种指代；要精确改请给 id')
  let pool = records
  if (args.match_book === 'home' || args.match_book === 'shop') pool = inBook(pool, args.match_book)
  if (args.match_entered_by) pool = pool.filter((record) => record.entered_by === args.match_entered_by)
  return lastWritten(pool)
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition