/**
 * The three-line reality check injected into every session (DESIGN.md 9).
 *
 * It must stay synchronous and cheap: it reads the in-memory index only, never
 * the filesystem, because Cordis calls it while assembling the prompt.
 * @module dsh-ledger/brief
 */

import { labelOf } from './categories.js'
import { formatMoney, shanghaiDate } from './util.js'

export function buildBrief(runtime) {
  const config = runtime.config
  if (!config.brief) return ''
  if (runtime.auth) {
    // The prompt hook is assembled per agent, not per message, so it cannot ask
    // who is speaking. A brief without numbers is the only honest version.
    return '账本已接入家庭权限：每个人只看到自己的记录，以及别人明确授权给他的。'
      + '用户问"花了多少 / 谁还欠着"时必须调用 ledger_report / ledger_debt 取当下权限范围内的数字，'
      + '不要凭记忆回答，也不要说"全家的总数"除非工具就是这么返回的。'
  }
  let records
  try {
    records = runtime.store.all()
  } catch {
    return ''
  }
  if (records.length === 0) {
    return [
      '记账插件已就绪（还没有任何记录）。用户说"花了多少钱/赚了多少/谁还欠着"就调用 ledger_* 工具；',
      '两本账：家里=生活开销，店里=生意现金与赊账。不要问用户"要不要记"，直接记。',
    ].join('')
  }

  const today = shanghaiDate(runtime.now())
  const month = today.slice(0, 7)
  const confirmed = records.filter((record) => record.status === 'confirmed')
  const homeMonth = confirmed.filter((record) => record.book === 'home' && record.occurred_on.startsWith(month))
  const spent = homeMonth.filter((record) => record.kind === 'expense').reduce((sum, r) => sum + r.amount_minor, 0)
  const refunded = homeMonth.filter((record) => record.kind === 'refund').reduce((sum, r) => sum + r.amount_minor, 0)
  const shopMonth = confirmed.filter((record) => record.book === 'shop' && record.occurred_on.startsWith(month))
  const sales = shopMonth.filter((record) => record.kind === 'sale').reduce((sum, r) => sum + r.amount_minor, 0)
  const openByPerson = new Map()
  for (const record of confirmed) {
    if (record.book !== 'shop') continue
    if (!['sale', 'purchase'].includes(record.kind)) continue
    const paid = Number.isInteger(record.paid_minor) ? record.paid_minor : record.amount_minor
    const open = record.amount_minor - paid
    if (open <= 0) continue
    const name = record.customer || record.supplier
    if (!name) continue
    openByPerson.set(name, (openByPerson.get(name) || 0) + open)
  }
  const receivable = [...openByPerson.entries()]
    .filter(([, amount]) => amount > 0)
    .reduce((sum, [, amount]) => sum + amount, 0)

  const topCategory = topSpending(homeMonth, records, month)
  const parts = [
    '账本现状（' + month + '）：家里支出 ' + formatMoney(spent - refunded) +
      (topCategory ? '（最多：' + topCategory + '）' : '') +
      '；店里卖出 ' + formatMoney(sales) +
      (receivable > 0 ? '；外面还欠 ' + formatMoney(receivable) : '') + '。',
  ]
  if (homeMonth.length === 0 && shopMonth.length === 0) {
    parts.push('本月还没有记录，用户一提钱就该记一笔。')
  } else {
    parts.push('用户说"花了多少/谁还欠着"时用 ledger_report / ledger_debt 查准数，别用这里的旧数当最终答案。')
  }
  return parts.join('').slice(0, 800)
}

function topSpending(homeMonth, all, month) {
  const byCategory = new Map()
  for (const record of homeMonth) {
    if (record.kind !== 'expense') continue
    const key = record.category?.l1 || 'other'
    byCategory.set(key, (byCategory.get(key) || 0) + record.amount_minor)
  }
  let best = null
  for (const [key, amount] of byCategory) {
    if (!best || amount > best.amount) best = { key, amount }
  }
  return best ? labelOf(best.key) + ' ' + formatMoney(best.amount) : ''
}
