/**
 * ledger_query: "did I already record that?" and "what did I write on the 12th".
 * Read-only; the newest entries come first. (DESIGN.md 7)
 * @module dsh-ledger/tools/query
 */

import { labelOf } from '../categories.js'
import { describeRecord, inBook, inPeriod, liveOnly, newestFirst } from './shared.js'

export function createQueryTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_query',
    description:
      'Look up recorded entries. Use it before adding when the user asks "did I record this?" or wants to see a day/month. '
      + 'Read-only. Prefer a narrow range (month or from/to) plus q; results are newest first and capped by limit.',
    parameters: {
      book: { type: 'string', description: 'home | shop | all；省略时查两本账。' },
      month: { type: 'string', description: '月份 YYYY-MM，如 "2026-10"。' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（含）。' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）。' },
      q: { type: 'string', description: '关键词：备注/商户/客户/供应商/类目名，任一处包含即命中。' },
      kind: { type: 'string', description: '只看某种记录，如 expense / sale / payment_in。' },
      category_l1: { type: 'string', description: '只看某个一级类目 slug，如 food。' },
      entered_by: { type: 'string', description: '只看某个人记的（谁录的）。' },
      include_void: { type: 'boolean', description: '包含已作废的记录（默认不含）。' },
      limit: { type: 'integer', description: '最多返回几条，默认 20，最大 100。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const config = runtime.config
      let records = runtime.view(exec).all()
      if (!args.include_void) records = liveOnly(records)
      records = inBook(records, args.book)
      records = inPeriod(records, { month: args.month, from: args.from, to: args.to })
      if (args.kind) records = records.filter((record) => record.kind === args.kind)
      if (args.category_l1) records = records.filter((record) => record.category?.l1 === args.category_l1)
      if (args.entered_by) records = records.filter((record) => record.entered_by === args.entered_by)
      if (args.q) {
        const needle = String(args.q).toLowerCase()
        records = records.filter((record) => haystack(record).includes(needle))
      }
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20))
      const hits = newestFirst(records)
      const shown = hits.slice(0, limit)
      const totalMinor = shown.reduce((sum, record) => sum + signedMinor(record), 0)

      const lines = shown.map((record) => '· ' + describeRecord(record, config) +
        (record.entered_by ? '（' + record.entered_by + ' 记）' : ''))
      const header = shown.length === 0
        ? '没有找到符合条件的记录'
        : '找到 ' + hits.length + ' 条，显示最近 ' + shown.length + ' 条（合计 ' + (totalMinor / 100).toFixed(2) + ' 元净额）'
      return {
        count: hits.length,
        shown: shown.length,
        records: shown.map((record) => ({
          id: record.id,
          occurred_on: record.occurred_on,
          kind: record.kind,
          book: record.book,
          amount_minor: record.amount_minor,
          status: record.status,
          note: record.note || '',
          category_l1: record.category?.l1 ?? null,
          merchant: record.merchant ?? null,
          customer: record.customer ?? null,
          supplier: record.supplier ?? null,
          entered_by: record.entered_by ?? null,
          created_at: record.created_at ?? null,
        })),
        text: [header, ...lines].join('\n'),
      }
    },
  })
}

function haystack(record) {
  return [
    record.note, record.merchant, record.customer, record.supplier,
    record.category?.l1, record.category?.l2,
    record.category?.l1 ? labelOf(record.category.l1) : '',
  ].filter(Boolean).join(' ').toLowerCase()
}

function signedMinor(record) {
  if (record.kind === 'expense' || record.kind === 'purchase') return -record.amount_minor
  if (record.kind === 'income' || record.kind === 'sale') return record.amount_minor
  return 0
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition
