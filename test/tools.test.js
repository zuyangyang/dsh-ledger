import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRuntime } from '../lib/runtime.js'
import { createAddTool } from '../lib/tools/add.js'
import { createQueryTool } from '../lib/tools/query.js'
import { createFixTool } from '../lib/tools/fix.js'
import { createReportTool } from '../lib/tools/report.js'
import { createDebtTool } from '../lib/tools/debt.js'
import { createExportTool } from '../lib/tools/export.js'
import { createDoctorTool } from '../lib/tools/doctor.js'

const identity = (definition) => definition
const NOW = new Date('2026-10-26T10:00:00+08:00')

function setup(overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-tools-'))
  const runtime = createRuntime({
    config: { dataDir, autoCommit: false, brief: false, skill: false, ...overrides },
    now: () => NOW,
    logger: { warn: () => {}, info: () => {} },
  })
  return {
    dataDir,
    runtime,
    add: createAddTool(runtime, identity),
    query: createQueryTool(runtime, identity),
    fix: createFixTool(runtime, identity),
    report: createReportTool(runtime, identity),
    debt: createDebtTool(runtime, identity),
    exporter: createExportTool(runtime, identity),
    doctor: createDoctorTool(runtime, identity),
  }
}

const run = (tool, args, exec = {}) => tool.execute(args, exec)

test('one sentence becomes one household entry with a receipt', async () => {
  const { add, runtime } = setup()
  const result = await run(add, { amount: '32', note: '午饭', source_text: '午饭32' })
  assert.equal(result.kind, 'expense')
  assert.equal(result.book, 'home')
  assert.equal(result.amount_minor, 3200)
  assert.equal(result.category_l1, 'food')
  assert.equal(result.entered_by, '未识别')
  assert.match(result.text, /已记/)
  assert.match(result.text, /¥32\.00/)
  assert.match(result.text, /\[家里\]/)
  assert.equal(runtime.store.all().length, 1)
})

test('a WeChat message is recorded under the account name dsh-im shows', async () => {
  const imDir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const accountsPath = join(imDir, 'workspaces.json')
  writeFileSync(accountsPath, JSON.stringify({ version: 2, aliases: { wx_mei: 'Mei' } }))
  const { add } = setup({ imAccounts: { enabled: true, path: accountsPath } })
  const source = '午饭32<dsh_im_source>{"channel":"weixin","botId":"wx_mei",'
    + '"senderName":"微信用户·o9cq806i","senderId":"o9cq806i@im.wechat"}</dsh_im_source>'
  const result = await run(add, { amount: '32', note: '午饭', source_text: source })
  assert.equal(result.entered_by, 'Mei')
  assert.equal(result.text.includes('Mei'), false, 'the receipt does not need the recorder name')
})

test('a retried identical call does not double-charge', async () => {
  const { add, runtime } = setup()
  const args = { amount: '32', note: '午饭', source_text: '午饭32' }
  await run(add, args)
  const second = await run(add, args)
  assert.equal(second.duplicate, true)
  assert.equal(runtime.store.all().length, 1)
})

test('the same content in a new message is recorded but flagged', async () => {
  const { add, runtime } = setup()
  await run(add, { amount: '32', note: '午饭', item_index: 0 })
  const second = await run(add, { amount: '32', note: '午饭', item_index: 1 })
  assert.equal(second.duplicate, false)
  assert.equal(runtime.store.all().length, 2)
  assert.ok(second.warnings.some((warning) => warning.includes('刚记过')))
})

test('the sender in the IM source block becomes entered_by and routes the book', async () => {
  const { add, runtime } = setup()
  runtime.store.rememberBookForActor('妈', 'shop')
  const sourceText = '卖了480<dsh_im_source>{"channel":"weixin","senderId":"wxid_mom","senderName":"妈"}</dsh_im_source>'
  const result = await run(add, { amount: '480', source_text: sourceText, note: '卖了480' })
  assert.equal(result.entered_by, '妈')
  assert.equal(result.book, 'shop')
  assert.equal(result.kind, 'sale')
  const stored = runtime.store.all()[0]
  assert.equal(stored.actor_source, 'im_source_name')
  assert.equal(stored.provenance.source_text.startsWith('卖了480'), true)
})

test('a credit sale names the customer and shows up as a receivable', async () => {
  const { add, debt } = setup()
  const result = await run(add, {
    amount: '480', kind: 'sale', book: 'shop', customer: '老陈', paid: '0',
    note: '老陈拿了两双，先欠着480', source_text: '老陈拿了两双，先欠着480',
  })
  assert.equal(result.paid_minor, 0)
  assert.equal(result.status, 'confirmed')
  const owed = await run(debt, { side: 'receivable' })
  assert.equal(owed.total_receivable_minor, 48000)
  assert.equal(owed.summaries[0].people[0].name, '老陈')
})

test('a credit sale with no name is a draft asking who took it', async () => {
  const { add } = setup()
  const result = await run(add, { amount: '480', kind: 'sale', book: 'shop', paid: '0', note: '先欠着480' })
  assert.equal(result.status, 'draft')
  assert.equal(result.customer, '散客')
  assert.ok(result.warnings.some((warning) => warning.includes('谁拿的')))
})

test('a purchase defaults to paid in cash and carries no expense category', async () => {
  const { add, runtime } = setup()
  const result = await run(add, { amount: '3000', kind: 'purchase', book: 'shop', note: '进货3000' })
  assert.equal(result.paid_minor, 300000)
  assert.equal(result.category_l1, null)
  assert.equal(runtime.store.get(result.id).settlement_source, 'inferred_default')
})

test('past dates are parsed, future dates are refused', async () => {
  const { add } = setup()
  const backfilled = await run(add, { amount: '32', note: '买菜', date_expr: '昨天' })
  assert.equal(backfilled.occurred_on, '2026-10-25')
  await assert.rejects(() => run(add, { amount: '32', note: '买菜', date_expr: '明天' }), /明天|未来/)
})

test('a dry run writes nothing and says how it would be recorded', async () => {
  const { add, runtime } = setup()
  const result = await run(add, { amount: '32', note: '午饭', dry_run: true })
  assert.equal(result.dry_run, true)
  assert.equal(runtime.store.all().length, 0)
  assert.match(result.text, /还没写进去/)
})

test('query finds entries by keyword and by month', async () => {
  const { add, query } = setup()
  await run(add, { amount: '32', note: '午饭', item_index: 0 })
  await run(add, { amount: '18', note: '打车', item_index: 1 })
  const hit = await run(query, { q: '打车' })
  assert.equal(hit.count, 1)
  assert.match(hit.text, /打车/)
  const month = await run(query, { month: '2026-10' })
  assert.equal(month.count, 2)
  assert.equal(month.records[0].occurred_on, '2026-10-26')
})

test('"the last one" can be re-priced, voided and moved between books', async () => {
  const { add, fix } = setup()
  const created = await run(add, { amount: '32', note: '午饭', item_index: 0 })
  const repriced = await run(fix, { match_pick: 'last', patch_amount: '40' })
  assert.equal(repriced.before.amount_minor, 3200)
  assert.equal(repriced.after.amount_minor, 4000)
  assert.equal(repriced.version, 2)
  assert.match(repriced.text, /改了/)

  const voided = await run(fix, { target_id: created.id, action: 'void' })
  assert.equal(voided.after.status, 'void')
  const restored = await run(fix, { target_id: created.id, action: 'restore' })
  assert.equal(restored.after.status, 'confirmed')
})

test('a mis-booked entry can be moved to the other book', async () => {
  const { add, fix, runtime } = setup()
  const created = await run(add, { amount: '50', note: '买鞋盒', item_index: 0 })
  const moved = await run(fix, { target_id: created.id, action: 'move_book', book: 'shop' })
  assert.equal(moved.after.book, 'shop')
  assert.equal(runtime.store.get(created.id).book, 'shop')
})

test('a day report and a month report describe the household book', async () => {
  const { add, report } = setup()
  await run(add, { amount: '32', note: '午饭', item_index: 0 })
  await run(add, { amount: '18', note: '打车', item_index: 1 })
  const day = await run(report, { period: 'day', date: '2026-10-26' })
  assert.match(day.text, /支出 ¥50\.00/)
  const month = await run(report, { period: 'month', month: '2026-10' })
  assert.match(month.text, /餐饮/)
  assert.match(month.text, /合计/)
})

test('the shop month report separates cash from debt', async () => {
  const { add, report } = setup()
  await run(add, { amount: '500', kind: 'sale', book: 'shop', customer: '老陈', paid: '200', note: '卖了500收了200' })
  await run(add, { amount: '300', kind: 'purchase', book: 'shop', note: '进货300', item_index: 1 })
  const result = await run(report, { period: 'month', month: '2026-10', book: 'shop' })
  assert.equal(result.summary.sales_minor, 50000)
  assert.equal(result.summary.cash_in_minor, 20000)
  assert.equal(result.summary.cash_out_minor, 30000)
  assert.match(result.text, /外面还欠我/)
  assert.match(result.text, /不算毛利/)
  assert.doesNotMatch(result.text, /毛利率/)
})

test('export writes derived files that can be deleted and rebuilt', async () => {
  const { add, exporter, dataDir } = setup()
  await run(add, { amount: '32', note: '午饭', item_index: 0 })
  const obsidian = await run(exporter, { what: 'obsidian', month: '2026-10' })
  assert.equal(obsidian.paths.length, 2)
  assert.equal(existsSync(join(dataDir, 'exports', 'obsidian', 'home', '2026-10.md')), true)
  const csv = await run(exporter, { what: 'csv', month: '2026-10' })
  const body = readFileSync(csv.paths[0], 'utf8')
  assert.match(body, /^date,book,kind/m)
  assert.match(body, /32\.00/)
  const debt = await run(exporter, { what: 'debt' })
  assert.equal(readdirSync(join(dataDir, 'exports', 'obsidian', 'debt')).length, 1)
})

test('a message with only a sender id is still attributed', async () => {
  const { add, runtime } = setup()
  const result = await run(add, {
    amount: '18',
    note: '打车',
    source_text: '打车18<dsh_im_source>{"channel":"weixin","senderId":"wxid_dad_only"}</dsh_im_source>',
    item_index: 0,
  })
  const stored = runtime.store.get(result.id)
  assert.equal(stored.entered_by, 'wxid_dad_only')
  assert.equal(stored.actor_source, 'im_source_id')
})

test('the doctor reports where the journal lives', async () => {
  const { add, doctor, dataDir } = setup()
  await run(add, { amount: '32', note: '午饭' })
  const result = await run(doctor, {})
  assert.equal(result.entries, 1)
  assert.equal(result.data_dir, dataDir)
  assert.equal(result.default_data_dir.endsWith('/.dsh/ledger'), true)
  assert.equal(result.data_dir_is_default, false)
  assert.equal(typeof result.other_data_dir_entries, 'number')
  assert.equal(result.actor_sources.unidentified, 1)
  assert.match(result.text, /记录：1 条/)
})