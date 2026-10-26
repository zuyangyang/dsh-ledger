/**
 * ledger_report: the three readings, never mixed (DESIGN.md 8).
 *
 * - home book: what did we spend, on what
 * - shop cash: what money actually came in and went out
 * - shop debt: who owes whom (ledger_debt)
 * @module dsh-ledger/tools/report
 */

import { renderDayReport, renderMonthReport, summarizeDay, summarizeMonth, summarizeShopCash } from '../views/report.js'
import { summarizeDebt } from '../views/debt.js'
import { fail } from './shared.js'
import { shanghaiDate } from '../util.js'

export function createReportTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_report',
    description:
      'Summarise a day, a month or a range. period=day|month|range. '
      + 'For the home book it reports spending by category; for the shop book it reports cash in/out and sales, '
      + 'plus open receivables/payables as a separate line (never added to income). '
      + 'Use month for "这个月花了多少", day for "今天花了多少", range for arbitrary spans.',
    parameters: {
      period: { type: 'string', description: 'day | month | range；省略时按给了哪些参数推断。' },
      date: { type: 'string', description: 'day 用：YYYY-MM-DD 或"昨天"这类词都由调用方先解析。' },
      month: { type: 'string', description: 'month 用：YYYY-MM。' },
      from: { type: 'string', description: 'range 起始日期 YYYY-MM-DD。' },
      to: { type: 'string', description: 'range 结束日期 YYYY-MM-DD。' },
      book: { type: 'string', description: 'home | shop | all，默认 home。' },
      format: { type: 'string', description: 'text（默认，给聊天看）| markdown（给 Obsidian 存）。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args) {
      const config = runtime.config
      const book = args.book === 'shop' ? 'shop' : args.book === 'all' ? 'all' : 'home'
      const records = runtime.store.all()
      const today = shanghaiDate(runtime.now())
      const period = inferPeriod(args, today)

      if (period.kind === 'day') {
        if (book === 'shop') {
          const month = period.date.slice(0, 7)
          const cash = summarizeShopCash(records, { month })
          const debt = summarizeDebt(records, { side: 'receivable', asOf: period.date })
          const text = [
            '## ' + period.date + ' 店里',
            '现金进出（本月累计）：进 ¥' + (cash.cash_in_minor / 100).toFixed(2)
              + ' / 出 ¥' + (cash.cash_out_minor / 100).toFixed(2)
              + ' / 净 ¥' + (cash.cash_net_minor / 100).toFixed(2),
            '本月卖出 ¥' + (cash.sales_minor / 100).toFixed(2)
              + '（零售 ' + (cash.retail_minor / 100).toFixed(2)
              + ' / 批发 ' + (cash.wholesale_minor / 100).toFixed(2) + '）',
            '外面还欠我 ¥' + (debt.total_minor / 100).toFixed(2),
          ].join('\n')
          return { period: period.kind, date: period.date, book, summary: cash, text }
        }
        const summary = summarizeDay(records, { date: period.date, book })
        return { period: 'day', date: period.date, book, summary, text: renderDayReport(summary) }
      }

      if (period.kind === 'month') {
        if (book === 'shop') {
          const cash = summarizeShopCash(records, { month: period.month })
          const receivable = summarizeDebt(records, { side: 'receivable', asOf: lastDayOfMonth(period.month) })
          const payable = summarizeDebt(records, { side: 'payable', asOf: lastDayOfMonth(period.month) })
          const lines = [
            '## ' + period.month + ' 店里',
            '',
            '| 项目 | 金额 |',
            '| --- | --- |',
            '| 卖出（含批发） | ¥' + (cash.sales_minor / 100).toFixed(2) + ' |',
            '| 进货付出 | ¥' + (cash.purchase_paid_minor / 100).toFixed(2) + ' |',
            '| 店里开支 | ¥' + (cash.expense_minor / 100).toFixed(2) + ' |',
            '| 现金净变化 | ¥' + (cash.cash_net_minor / 100).toFixed(2) + ' |',
            '',
            '外面还欠我 ¥' + (receivable.total_minor / 100).toFixed(2) + '，我欠外面 ¥' + (payable.total_minor / 100).toFixed(2) + '。',
            '（这里不算毛利：没记成本价，硬算会骗人。）',
          ]
          return { period: 'month', month: period.month, book, summary: cash, receivable, payable, text: lines.join('\n') }
        }
        const summary = summarizeMonth(records, { month: period.month, book })
        return { period: 'month', month: period.month, book, summary, text: renderMonthReport(summary) }
      }

      if (book === 'shop') {
        const cash = summarizeShopCash(records, { from: period.from, to: period.to })
        return { period: 'range', from: period.from, to: period.to, book, summary: cash, text: '（区间经营报表先给出合计）\n现金净变化 ¥' + (cash.cash_net_minor / 100).toFixed(2) }
      }
      const day = { from: period.from, to: period.to }
      const summary = summarizeMonth(records, { ...day, book })
      return { period: 'range', ...day, book, summary, text: renderMonthReport({ ...summary, month: period.from + ' ~ ' + period.to }) }
    },
  })
}

function inferPeriod(args, today) {
  if (args.period === 'day' || (!args.period && args.date)) return { kind: 'day', date: args.date || today }
  if (args.period === 'range' || (!args.period && (args.from || args.to))) {
    if (!args.from || !args.to) fail({ message: '区间要同时给开始和结束日期' })
    if (args.from > args.to) fail({ message: '开始日期比结束日期还晚' })
    return { kind: 'range', from: args.from, to: args.to }
  }
  const month = args.month || today.slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(month)) fail({ message: '月份要写成 2026-10 这样' })
  return { kind: 'month', month }
}

function lastDayOfMonth(month) {
  const [year, mon] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, mon, 0))
  return date.toISOString().slice(0, 10)
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition
