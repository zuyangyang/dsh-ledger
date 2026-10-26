import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')

/** The host hands the browser half a stub React; that is enough to render a tree. */
function fakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(4).filter((child) => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) { return [initial, () => {}] },
    useCallback(fn) { return fn },
    useEffect() {},
  }
}

function loadClient() {
  let entry = null
  const sandbox = { window: { __ModuleLoader__: { load: (value) => { entry = value } } } }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(entry, 'client bundle must call window.__ModuleLoader__.load')
  const react = fakeReact()
  const module = entry.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  return { entry, module, react }
}

/** Collect every string rendered anywhere in an element tree. */
function texts(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (typeof node.type === 'function') return texts(node.type(node.props), out)
  for (const child of node.children) texts(child, out)
  return out
}

test('the client bundle registers under the package id', () => {
  const { entry } = loadClient()
  assert.equal(entry.id, 'dsh-ledger')
  assert.equal(typeof entry.factory, 'function')
})

test('apply registers one settings section ordered before Memory', () => {
  const { module } = loadClient()
  assert.deepEqual([...module.inject], ['slots'])
  const registrations = []
  const ctx = {
    slots: {
      inject: (name, run) => { assert.equal(name, 'settings.section'); run() },
      register: (definition, component) => { registrations.push({ definition, component }) },
    },
  }
  module.apply(ctx)
  assert.equal(registrations.length, 1)
  const { definition, component } = registrations[0]
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'dsh-ledger')
  assert.equal(typeof definition.order, 'number')
  assert.equal(definition.order < 100, true, 'must sit before Memory (order 100)')
  assert.equal(definition.label(), 'Ledger')
  assert.equal(typeof component, 'function')
})

test('money and share formatting match the receipts', () => {
  const { module } = loadClient()
  const { formatMoney, formatShare, shortDate } = module.__test
  assert.equal(formatMoney(3200), '¥32.00')
  assert.equal(formatMoney(123456789), '¥1,234,567.89')
  assert.equal(formatMoney(-5), '-¥0.05')
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney('nope'), '¥0.00')
  assert.equal(formatShare(1250), '12.5%')
  assert.equal(formatShare(10000), '100.0%')
  assert.equal(shortDate('2026-10-05'), '10-05')
})

function payload(overrides = {}) {
  return {
    generated_at: '2026-10-26T13:40:00+08:00',
    month: '2026-10',
    months: [
      { month: '2026-05', home_spent_minor: 0, shop_sales_minor: 0 },
      { month: '2026-06', home_spent_minor: 0, shop_sales_minor: 0 },
      { month: '2026-07', home_spent_minor: 0, shop_sales_minor: 0 },
      { month: '2026-08', home_spent_minor: 0, shop_sales_minor: 0 },
      { month: '2026-09', home_spent_minor: 12000, shop_sales_minor: 0 },
      { month: '2026-10', home_spent_minor: 2690, shop_sales_minor: 48000 },
    ],
    storage: { data_dir: '/Users/x/.dsh/ledger', is_default: true, default_data_dir: '/Users/x/.dsh/ledger', entries: 3, quarantined: 0, bytes: 900, git_ready: true, git_enabled: true, git_error: null },
    home: {
      month: '2026-10', count: 1, expense_minor: 2690, refund_minor: 0, income_minor: 0, net_minor: -2690, uncategorized_count: 0,
      by_category: [{ key: 'food', label: '餐饮', minor: 2690, share_bp: 10000, count: 1 }],
      by_day: [], biggest: [],
    },
    shop: { month: '2026-10', sales_minor: 48000, sales_count: 1, retail_minor: 48000, wholesale_minor: 0, cash_in_minor: 0, cash_out_minor: 0, cash_net_minor: 0, purchase_total_minor: 0, purchase_paid_minor: 0, expense_minor: 0 },
    receivable: { total_minor: 48000, people_count: 1, people: [{ name: '老陈', open_minor: 48000, age_days: 6, oldest_on: '2026-10-20', items: 1 }], scattered_minor: 0 },
    payable: { total_minor: 0, people_count: 0, people: [], scattered_minor: 0 },
    recent: [{ id: 'tx_1', date: '2026-10-26', book: 'home', kind: 'expense', kind_label: '支出', amount_minor: 2690, paid_minor: 2690, category_label: '餐饮', counterparty: null, note: '今天午饭花了26块9', entered_by: 'yang', status: 'confirmed' }],
    config: { data_dir: '/Users/x/.dsh/ledger', shop_name: '店里', default_actor: 'yang', default_book: 'home' },
    ...overrides,
  }
}

const configPayload = {
  ui_config_path: '/Users/x/.dsh/ledger-ui.json',
  settings: [
    { key: 'dataDir', label: '账本目录', type: 'string', options: null, min: null, max: null, hint: null, value: '/Users/x/.dsh/ledger', source: 'deployment' },
    { key: 'nightlyEnabled', label: '夜间小结', type: 'boolean', options: null, min: null, max: null, hint: null, value: true, source: 'default' },
    { key: 'defaultBook', label: '默认账本', type: 'choice', options: ['home', 'shop'], min: null, max: null, hint: null, value: 'home', source: 'default' },
  ],
}

test('the panel shows last month by default, honest about storage', () => {
  const { module } = loadClient()
  const text = texts(module.__test.LedgerPanel({ data: payload(), config: configPayload, draft: {}, error: null })).join(' | ')
  assert.match(text, /账本 · 2026-10/)
  assert.match(text, /家里支出/)
  assert.match(text, /¥26\.90/)
  assert.match(text, /店里卖出/)
  assert.match(text, /¥480\.00/)
  assert.match(text, /应收（别人欠店里）/)
  assert.match(text, /老陈/)
  assert.match(text, /最近记录/)
  assert.match(text, /账本目录/)
  assert.match(text, /（默认）/)
  assert.match(text, /保存/)
})

test('the panel renders every config field with its source badge', () => {
  const { module } = loadClient()
  const text = texts(module.__test.LedgerPanel({ data: payload(), config: configPayload, draft: { nightlyEnabled: false }, error: null })).join(' | ')
  assert.match(text, /配置/)
  assert.match(text, /账本目录/)
  assert.match(text, /配置文件/, 'deployment source badge')
  assert.match(text, /默认/, 'default source badge')
  assert.match(text, /家里/, 'choice labels are translated')
})

test('an empty book still renders a readable panel', () => {
  const { module } = loadClient()
  const text = texts(module.__test.LedgerPanel({ data: payload({ receivable: { total_minor: 0, people_count: 0, people: [], scattered_minor: 0 }, recent: [], home: { ...payload().home, count: 0, expense_minor: 0, by_category: [] }, shop: { ...payload().shop, sales_minor: 0, sales_count: 0, cash_in_minor: 0, cash_out_minor: 0, cash_net_minor: 0 } }), config: configPayload, draft: {} })).join(' | ')
  assert.match(text, /这个月还没有家里支出/)
  assert.match(text, /没有赊账/)
  assert.match(text, /还没有记录/)
})

test('before the first fetch the panel says so instead of crashing', () => {
  const { module } = loadClient()
  const text = texts(module.__test.LedgerPanel({ data: null, error: null })).join(' | ')
  assert.match(text, /正在读账本/)
  const failed = texts(module.__test.LedgerPanel({ data: null, error: 'HTTP 500' })).join(' | ')
  assert.match(failed, /读不到账本：HTTP 500/)
})