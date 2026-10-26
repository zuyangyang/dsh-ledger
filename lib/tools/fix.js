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
      match: {
        type: 'object',
        description: '没给 id 时按条件找：{ pick: "last", book?, entered_by? }。',
        properties: {
          pick: { type: 'string', description: '目前只支持 "last"：最近写的一条。' },
          book: { type: 'string', description: '限定账本 home | shop。' },
          entered_by: { type: 'string', description: '限定是谁记的。' },
        },
      },
      patch: {
        type: 'object',
        description: '要改的字段：amount/occurred_on/category_l1/category_l2/merchant/note/customer/supplier/paid。不能改 kind 与 book（换账本用 action）。',
        properties: {
          amount: { type: 'string', description: '新的金额原文，如 "680"。' },
          occurred_on: { type: 'string', description: '新的日期 YYYY-MM-DD。' },
          category_l1: { type: 'string', description: '新的一级类目 slug。' },
          category_l2: { type: 'string', description: '新的二级类目 slug。' },
          merchant: { type: 'string', description: '新的商户名。' },
          note: { type: 'string', description: '新的备注。' },
          customer: { type: 'string', description: '新的客户名。' },
          supplier: { type: 'string', description: '新的供应商名。' },
          paid: { type: 'string', description: '新的已收/已付金额原文（赊账改口时用）。' },
        },
      },
      action: { type: 'string', description: 'void 作废 | restore 恢复 | confirm 确认 | unconfirm 退回待确认 | move_book 换账本。' },
      book: { type: 'string', description: 'move_book 时的目标账本 home | shop。' },
      expected_version: { type: 'integer', description: '并发保护：目标当前版本号，不确定就省略。' },
      source_text: { type: 'string', description: '整条用户消息原文（用于识别是谁发的）。' },
      entered_by: { type: 'string', description: '录入人；消息里有 <dsh_im_source> 的 senderName 就传它。' },
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
      if (args.patch && typeof args.patch === 'object') {
        if (args.patch.amount !== undefined) {
          const parsed = parseAmount(args.patch.amount)
          if (!parsed.ok) fail(parsed)
          patch.amount_minor = parsed.minor
        }
        if (args.patch.paid !== undefined) {
          patch.paid_minor = parsePaid(args.patch.paid)
          patch.settlement_source = 'corrected'
        }
        if (args.patch.occurred_on !== undefined) {
          const parsed = parseDate(args.patch.occurred_on, { now: runtime.now(), dayCutoffHour: config.dayCutoffHour })
          if (!parsed.ok) fail(parsed)
          patch.occurred_on = parsed.date
          patch.date_source = parsed.source === 'explicit_absolute' ? 'explicit_abs' : parsed.source
        }
        if (args.patch.category_l1 !== undefined || args.patch.category_l2 !== undefined) {
          patch.category = {
            ...(target.category || {}),
            ...(args.patch.category_l1 !== undefined ? { l1: args.patch.category_l1 } : {}),
            ...(args.patch.category_l2 !== undefined ? { l2: args.patch.category_l2 } : {}),
            source: 'manual',
          }
        }
        for (const field of ['merchant', 'note', 'customer', 'supplier']) {
          if (args.patch[field] !== undefined) patch[field] = args.patch[field]
        }
      }

      if (args.action && !ACTIONS.includes(args.action)) throw new Error('不支持的改法：' + args.action)
      if (args.action === 'void') {
        patch.status = 'void'
        patch.voided_at = runtime.now().toISOString()
        patch.void_reason = args.patch?.note || '用户要求作废'
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

      const { actor } = resolveActor({ enteredBy: args.entered_by, sourceText: args.source_text, config })
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
  const pick = args.match?.pick
  if (!pick) return null
  if (pick !== 'last') throw new Error('只支持「最后那笔」这种指代；要精确改请给 id')
  let pool = records
  if (args.match.book === 'home' || args.match.book === 'shop') pool = inBook(pool, args.match.book)
  if (args.match.entered_by) pool = pool.filter((record) => record.entered_by === args.match.entered_by)
  return lastWritten(pool)
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition