/**
 * ledger_export: derived artifacts. Everything written here can be deleted and
 * rebuilt from entries.ndjson (DESIGN.md 15.6).
 * @module dsh-ledger/tools/export
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { labelOf } from '../categories.js'
import { renderMonthReport, summarizeMonth } from '../views/report.js'
import { renderDebtReport, summarizeDebt } from '../views/debt.js'
import { fail, inBook, inPeriod, liveOnly } from './shared.js'
import { shanghaiDate } from '../util.js'

export function createExportTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_export',
    description:
      'Write derived files into the ledger directory: what=obsidian writes month markdown (one file per book/month), '
      + 'what=csv writes a spreadsheet of the range, what=debt writes the current debt table. '
      + 'These files are regenerated artifacts; the journal is the source of truth. Returns the paths written.',
    parameters: {
      what: { type: 'string', description: 'obsidian | csv | debt。' },
      month: { type: 'string', description: '月份 YYYY-MM，默认本月。' },
      from: { type: 'string', description: 'csv 用的起始日期（含）。' },
      to: { type: 'string', description: 'csv 用的结束日期（含）。' },
      book: { type: 'string', description: 'home | shop | all，默认 all。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args) {
      const config = runtime.config
      const what = args.what || 'obsidian'
      const month = args.month || shanghaiDate(runtime.now()).slice(0, 7)
      const root = join(config.dataDir, 'exports')
      const records = liveOnly(runtime.store.all())
      const written = []

      if (what === 'obsidian') {
        if (!config.obsidian.enabled) throw new Error('Obsidian 导出已在配置里关掉了')
        const targets = args.book === 'home' ? ['home'] : args.book === 'shop' ? ['shop'] : ['home', 'shop']
        for (const book of targets) {
          const summary = summarizeMonth(records, { month, book })
          const body = renderMonthReport({ ...summary, month }) + '\n'
          const dir = book === 'shop' ? 'shop' : 'home'
          const path = join(root, 'obsidian', dir, month + '.md')
          mkdirSync(join(root, 'obsidian', dir), { recursive: true, mode: 0o700 })
          writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
          written.push(path)
        }
      } else if (what === 'csv') {
        const from = args.from || month + '-01'
        const to = args.to || month + '-31'
        const rows = inPeriod(inBook(records, args.book || 'all'), { from, to })
        const header = ['date', 'book', 'kind', 'status', 'amount_cny', 'paid_cny', 'category', 'counterparty', 'note', 'entered_by', 'created_at']
        const lines = [header.join(',')]
        for (const record of rows) {
          lines.push([
            record.occurred_on,
            record.book,
            record.kind,
            record.status,
            (record.amount_minor / 100).toFixed(2),
            record.paid_minor === null || record.paid_minor === undefined ? '' : (record.paid_minor / 100).toFixed(2),
            record.category?.l1 ? labelOf(record.category.l1) : '',
            csvCell(record.customer || record.supplier || record.merchant || ''),
            csvCell(record.note || ''),
            record.entered_by || '',
            record.created_at || '',
          ].join(','))
        }
        const path = join(root, 'csv', 'ledger-' + from + '_' + to + '.csv')
        mkdirSync(join(root, 'csv'), { recursive: true, mode: 0o700 })
        writeFileSync(path, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 })
        written.push(path)
      } else if (what === 'debt') {
        const asOf = shanghaiDate(runtime.now())
        const receivable = summarizeDebt(records, { side: 'receivable', asOf })
        const payable = summarizeDebt(records, { side: 'payable', asOf })
        const body = renderDebtReport(receivable) + '\n\n' + renderDebtReport(payable) + '\n'
        const path = join(root, 'obsidian', 'debt', asOf + '.md')
        mkdirSync(join(root, 'obsidian', 'debt'), { recursive: true, mode: 0o700 })
        writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
        written.push(path)
      } else {
        fail({ message: '不支持导出这种内容：' + what })
      }

      return {
        what,
        paths: written,
        text: '已导出 ' + written.length + ' 个文件：\n' + written.map((path) => '· ' + path).join('\n'),
      }
    },
  })
}

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition
