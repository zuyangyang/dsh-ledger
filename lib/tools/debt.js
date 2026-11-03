/**
 * ledger_debt: who owes the shop, and whom the shop owes.
 *
 * This is the only place a receivable number may come from. Reports show it as
 * a separate line, never inside income.
 * @module dsh-ledger/tools/debt
 */

import { renderDebtReport, summarizeDebt } from '../views/debt.js'
import { shanghaiDate } from '../util.js'

export function createDebtTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_debt',
    description:
      'Who owes us money (receivable) and whom we owe (payable), by person, with aging. '
      + 'Use for "外面还欠多少"、"谁还欠着"、"我欠厂家多少"、"老陈还欠多少". '
      + 'side defaults to receivable; pass both to see the two sides. As-of defaults to today.',
    parameters: {
      side: { type: 'string', description: 'receivable（别人欠我）| payable（我欠别人）| both。' },
      as_of: { type: 'string', description: '截止日期 YYYY-MM-DD，默认今天。' },
      person: { type: 'string', description: '只看某个人，如"老陈"。' },
      min_open: { type: 'string', description: '只列欠款不少于这个金额的人，如 "100"。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const asOf = args.as_of || shanghaiDate(runtime.now())
      const records = runtime.view(exec).all()
      const side = args.side === 'payable' ? 'payable' : args.side === 'both' ? 'both' : 'receivable'
      const sides = side === 'both' ? ['receivable', 'payable'] : [side]
      const summaries = sides.map((one) => summarizeDebt(records, { side: one, asOf }))
      if (args.min_open) {
        const minMinor = Math.round(Number(String(args.min_open).replace(/[^\d.]/g, '')) * 100) || 0
        for (const summary of summaries) {
          summary.people = summary.people.filter((person) => person.open_minor >= minMinor)
          summary.total_minor = summary.people.reduce((sum, person) => sum + person.open_minor, 0)
        }
      }
      if (args.person) {
        for (const summary of summaries) {
          summary.people = summary.people.filter((person) => person.name.includes(args.person))
          summary.total_minor = summary.people.reduce((sum, person) => sum + person.open_minor, 0)
        }
      }
      const texts = summaries.map((summary) => renderDebtReport(summary))
      return {
        as_of: asOf,
        total_receivable_minor: summaries.find((s) => s.side === 'receivable')?.total_minor ?? 0,
        total_payable_minor: summaries.find((s) => s.side === 'payable')?.total_minor ?? 0,
        summaries: summaries.map((summary) => ({
          side: summary.side,
          total_minor: summary.total_minor,
          people: summary.people.map((person) => ({
            name: person.name,
            open_minor: person.open_minor,
            oldest_on: person.oldest_on,
            age_days: person.age_days,
            bucket: person.bucket,
          })),
        })),
        text: texts.join('\n\n'),
      }
    },
  })
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition
