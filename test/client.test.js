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
      const flat = children.flat(4).filter((child) => child !== null && child !== undefined && child !== false)
      const merged = { ...(props || {}) }
      // React hands children to a component through props.children; the stub must
      // do the same or every wrapper component renders an empty box here.
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      return { type, props: merged, children: flat }
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
    { key: 'autoCommit', label: '自动提交', type: 'boolean', options: null, min: null, max: null, hint: null, value: true, source: 'default' },
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
  const text = texts(module.__test.LedgerPanel({ data: payload(), config: configPayload, draft: { autoCommit: false }, error: null })).join(' | ')
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
function rangePayload(overrides = {}) {
  return {
    range: { from: '2026-10-01', to: '2026-10-30', days: 30, label: '10-01 → 10-30', bucket: 'day' },
    generated_at: '2026-10-30T17:52:10+08:00',
    storage: { data_dir: '/Users/x/ledger', is_default: false, entries: 4, quarantined: 0, bytes: 900, matched: 3, git_ready: true, git_enabled: true, git_error: null, git_nested_in: null },
    totals: {
      home: { count: 2, expense_minor: 1200, refund_minor: 0, income_minor: 0, net_minor: -1200, uncategorized_count: 0, active_days: 2, avg_per_day_minor: 40 },
      shop: { count: 1, sales_minor: 48000, sales_count: 1, cash_in_minor: 0, cash_out_minor: 0, cash_net_minor: 0, credit_out_minor: 48000, purchase_total_minor: 0, purchase_paid_minor: 0, expense_minor: 0, uncategorized_count: 0 },
    },
    series: { bucket: 'day', points: [] },
    categories: { rows: [], total_minor: 0, uncategorized: { minor: 0, count: 0 } },
    top: [], recent: [], debt: { as_of: '2026-10-30', receivable: { total_minor: 48000, people_count: 1, people: [], scattered_minor: 0 }, payable: { total_minor: 0, people_count: 0, people: [], scattered_minor: 0 } },
    compare: { from: '2026-09-01', to: '2026-09-30', previous_minor: 0, current_minor: 1200, delta_minor: 0, delta_bp: 0, comparable: false },
    summary: [{ kind: 'volume', text: '10-01 → 10-30家里花了 ¥12.00，日均 ¥0.40。' }],
    ...overrides,
  }
}

function dockView(overrides = {}) {
  return { preset: 'last30', from: '2026-10-01', to: '2026-10-30', group: 'book', book: 'all', ...overrides }
}

test('the corner button stays put and turns into the closer', () => {
  const { module } = loadClient()
  const { LedgerDock } = module.__test
  const closed = LedgerDock({ open: false, view: dockView(), onOpen: () => {}, onClose: () => {} })
  assert.equal(Array.isArray(closed), true, 'the dock answers with its parts')
  assert.equal(closed.length, 1, 'nothing else is drawn when closed')
  const closedButton = closed[0].type(closed[0].props)
  assert.equal(closedButton.type, 'button')
  assert.equal(closedButton.props['aria-label'], '账本看板')
  assert.deepEqual(texts(closedButton), ['账'])

  let closes = 0
  const open = LedgerDock({
    open: true, data: rangePayload(), view: dockView(),
    onOpen: () => {}, onClose: () => { closes += 1 }, onRefresh: () => {},
    onPreset: () => {}, onCustomFrom: () => {}, onCustomTo: () => {}, onGroup: () => {}, onBook: () => {},
  })
  assert.equal(Array.isArray(open), true)
  assert.equal(open.length, 2, 'button and dialog, the entrance is not swallowed')
  const openButton = open[0].type(open[0].props)
  assert.deepEqual(texts(openButton), ['×'])
  assert.equal(openButton.props['aria-label'], '关闭账本看板')
  assert.equal(openButton.props.style.zIndex > 2147482100, true, 'sits above the overlay')
  openButton.props.onClick()
  assert.equal(closes, 1, 'clicking it closes the panel')
  assert.match(texts(open[1]).join(' | '), /账本看板/)
})

test('the open dock renders the summary, the cards and where the numbers came from', () => {
  const { module } = loadClient()
  const { LedgerDock } = module.__test
  const tree = LedgerDock({
    open: true,
    data: rangePayload(),
    view: dockView(),
    onOpen: () => {}, onClose: () => {}, onRefresh: () => {},
    onPreset: () => {}, onCustomFrom: () => {}, onCustomTo: () => {}, onGroup: () => {}, onBook: () => {},
  })
  const rendered = texts(tree).join(' | ')
  assert.match(rendered, /账本看板/)
  assert.match(rendered, /10-01 → 10-30/)
  assert.match(rendered, /家里花了 ¥12\.00/)
  assert.match(rendered, /家里支出/)
  assert.match(rendered, /¥12\.00/)
  assert.match(rendered, /店里卖出/)
  assert.match(rendered, /应收未收/)
  assert.match(rendered, /\/Users\/x\/ledger（自定义位置）/)
  assert.match(rendered, /命中 3 条/)
  assert.match(rendered, /读于 17:52:10/)
  assert.match(rendered, /关闭/)
})

test('a dock that cannot read the journal says so instead of showing zeroes', () => {
  const { module } = loadClient()
  const { LedgerDock } = module.__test
  const failed = texts(LedgerDock({ open: true, data: null, error: 'HTTP 500', view: dockView() })).join(' | ')
  assert.match(failed, /读不到账本：HTTP 500/)
  assert.equal(/正在读账本/.test(failed), false)
  const loading = texts(LedgerDock({ open: true, data: null, error: null, view: dockView() })).join(' | ')
  assert.match(loading, /正在读账本/)
})

test('range presets are computed from today, and recognised back', () => {
  const { module } = loadClient()
  const { presetRange, presetOf, isoDay, addDaysIso, shiftMonthIso } = module.__test
  const today = '2026-10-26'
  // vm 里造出来的对象原型不同，摊平成宿主对象再比。
  assert.deepEqual({ ...presetRange('last7', today) }, { from: '2026-10-20', to: '2026-10-26' })
  assert.deepEqual({ ...presetRange('last30', today) }, { from: '2026-09-27', to: '2026-10-26' })
  assert.deepEqual({ ...presetRange('thisMonth', today) }, { from: '2026-10-01', to: '2026-10-31' })
  assert.deepEqual({ ...presetRange('lastMonth', today) }, { from: '2026-09-01', to: '2026-09-30' })
  assert.equal(presetRange('custom', today), null)
  assert.equal(presetOf({ from: '2026-09-27', to: '2026-10-26' }, today), 'last30')
  assert.equal(presetOf({ from: '2026-09-01', to: '2026-09-30' }, today), 'lastMonth')
  assert.equal(presetOf({ from: '2026-01-02', to: '2026-01-09' }, today), 'custom')
  assert.equal(isoDay(new Date(2026, 9, 5)), '2026-10-05')
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28', 'a leap year matters')
  assert.equal(addDaysIso('2024-03-01', -1), '2024-02-29')
  assert.equal(shiftMonthIso('2026-01', -1), '2025-12')
  assert.equal(shiftMonthIso('2026-12', 1), '2027-01')
})

test('the dock asks the route for exactly the view it shows', () => {
  const { module } = loadClient()
  const { rangeQuery } = module.__test
  const url = rangeQuery(dockView({ group: 'actor', book: 'home' }))
  assert.match(url, /^\/api\/ledger\/range\?/)
  assert.match(url, /from=2026-10-01/)
  assert.match(url, /to=2026-10-30/)
  assert.match(url, /group=actor/)
  assert.match(url, /book=home/)
})
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node.type === 'function') return findAll(node.type(node.props), predicate, out)
  if (predicate(node)) out.push(node)
  for (const child of node.children) findAll(child, predicate, out)
  return out
}

function renderedAxis(tree) {
  return findAll(tree, (node) => node.props && node.props.style && node.props.style.position === 'absolute'
    && /^¥/.test(texts(node).join(''))).map((node) => texts(node).join('')).join(' ')
}

function openDock(payload, extra = {}) {
  const { module } = loadClient()
  return module.__test.LedgerDock({
    open: true,
    data: payload,
    view: dockView(),
    onOpen: () => {}, onClose: () => {}, onRefresh: () => {},
    onPreset: () => {}, onCustomFrom: () => {}, onCustomTo: () => {}, onGroup: () => {}, onBook: () => {},
    ...extra,
  })
}

function fullPayload() {
  const points = []
  for (let index = 0; index < 30; index += 1) {
    points.push({
      key: '2026-10-' + String(index + 1).padStart(2, '0'),
      label: '10-' + String(index + 1).padStart(2, '0'),
      home_expense_minor: index === 4 ? 1200 : 0,
      home_income_minor: index === 9 ? 30000 : 0,
      home_refund_minor: 0,
      shop_sales_minor: 0,
      shop_cash_net_minor: 0,
      count: index === 4 || index === 9 ? 1 : 0,
    })
  }
  return rangePayload({
    series: { bucket: 'day', points },
    categories: {
      rows: [{ key: 'food', label: '餐饮', minor: 1200, count: 2, share_bp: 10000 }],
      total_minor: 1200,
      uncategorized: { minor: 300, count: 1 },
    },
    top: [],
    recent: [
      { id: 'tx_1', date: '2026-10-20', book: 'home', kind: 'expense', kind_label: '支出', amount_minor: 1200, paid_minor: 1200, category_label: '餐饮', counterparty: null, note: '午饭', entered_by_name: '妈', status: 'confirmed' },
      { id: 'tx_2', date: '2026-10-19', book: 'shop', kind: 'transfer', kind_label: '转账', amount_minor: 100000, paid_minor: 100000, category_label: null, counterparty: null, note: '取现', entered_by_name: '杨', status: 'confirmed' },
    ],
    debt: {
      as_of: '2026-10-30',
      receivable: { total_minor: 48000, people_count: 1, scattered_minor: 0, people: [{ name: '老陈', open_minor: 48000, age_days: 47, oldest_on: '2026-09-01' }] },
      payable: { total_minor: 0, people_count: 0, scattered_minor: 0, people: [] },
    },
  })
}

test('the trend chart draws one bar per day and a line only when money came in', () => {
  const tree = openDock(fullPayload())
  const bars = findAll(tree, (node) => String(node.props['aria-label'] || node.props.title || '').includes('支出'))
  assert.equal(bars.length, 30)
  // every chart carries a money axis, otherwise a bar is just a grey rectangle
  assert.match(renderedAxis(tree), /¥500/)
  assert.match(renderedAxis(tree), /¥0/)
  const polylines = findAll(tree, (node) => node.type === 'polyline')
  assert.equal(polylines.length, 1)
  const withoutIncome = fullPayload()
  withoutIncome.series.points = withoutIncome.series.points.map((point) => ({ ...point, home_income_minor: 0 }))
  assert.equal(findAll(openDock(withoutIncome), (node) => node.type === 'polyline').length, 0, 'no income, no line')
})

test('the dock names the unclassified money instead of hiding it in 其他', () => {
  const rendered = texts(openDock(fullPayload())).join(' | ')
  assert.match(rendered, /未归类 1 笔 ¥3\.00/)
  assert.match(rendered, /餐饮/)
  assert.match(rendered, /店里卖出/)
  assert.match(rendered, /赊出 \| ¥480\.00/)
})

test('recent rows carry the recorder, and cash moves admit they are not spending', () => {
  const rendered = texts(openDock(fullPayload())).join(' | ')
  assert.match(rendered, /午饭 · 餐饮/)
  assert.match(rendered, /不计收支/)
  assert.match(rendered, /应收（别人欠我）/)
  assert.match(rendered, /老陈/)
  assert.match(rendered, /47 天/)
  assert.match(rendered, /没有欠账/)
})

test('an empty range says so and offers the way back', () => {
  const empty = rangePayload({
    storage: { data_dir: '/tmp/ledger', is_default: true, entries: 0, quarantined: 0, bytes: 0, matched: 0, git_ready: false, git_enabled: true, git_error: null, git_nested_in: null },
    totals: { home: { count: 0, expense_minor: 0, refund_minor: 0, income_minor: 0, net_minor: 0, uncategorized_count: 0, active_days: 0, avg_per_day_minor: 0 } },
    summary: [{ kind: 'empty', text: '这段时间没有记录。' }],
    series: { bucket: 'day', points: [] },
  })
  const tree = openDock(empty)
  const rendered = texts(tree).join(' | ')
  assert.match(rendered, /这段时间没有记录/)
  assert.match(rendered, /换个范围试试/)
  const presets = findAll(tree, (node) => node.type === 'button' && texts(node).join('') === '近 30 天')
  assert.ok(presets.length >= 1, 'the way back is a real button')
})
function actorPayload() {
  const payload = fullPayload()
  const dayKeys = payload.series.points.map((point) => point.key)
  // the server's actor points carry key + minor only — no label. The fixtures kept
  // inventing one, which is how a crash slipped through.
  const points = (values) => dayKeys.map((key) => ({ key, minor: values[key] || 0 }))
  payload.actors = [
    {
      key: 'ma', name: '妈', name_source: 'alias', expense_minor: 1200, refund_minor: 0, count: 2,
      share_bp: 9000, uncategorized_count: 1, avg_minor: 600, active_days: 2,
      points: points({ '2026-10-05': 1200 }),
    },
    {
      key: 'o9cq806i@im.wechat', name: '微信用户·o9cq806i', name_source: 'id', expense_minor: 300, refund_minor: 0, count: 1,
      share_bp: 1000, uncategorized_count: 0, avg_minor: 300, active_days: 1,
      points: points({ '2026-10-09': 300 }),
    },
  ]
  return payload
}

test('the per-person view ranks recorders and lets a name be fixed in place', () => {
  const tree = openDock(actorPayload(), { view: dockView({ group: 'actor' }) })
  const rendered = texts(tree).join(' | ')
  assert.match(rendered, /谁记的/)
  assert.match(rendered, /2 人/)
  assert.match(rendered, /妈/)
  assert.match(rendered, /90\.0%/)
  assert.match(rendered, /1 未归类/)
  assert.match(rendered, /微信用户·o9cq806i/)
  const renames = findAll(tree, (node) => node.type === 'input' && String(node.props['aria-label'] || '').includes('改名'))
  assert.equal(renames.length, 2)
  assert.equal(renames[0].props.defaultValue, '妈')
  const columns = findAll(tree, (node) => node.props.style && node.props.style.flexDirection === 'column-reverse')
  assert.equal(columns.length, 30, 'one stacked column per day')
})

test('the per-person view is only built when the lens is per-person', () => {
  const bookMode = texts(openDock(actorPayload(), { view: dockView() })).join(' | ')
  assert.equal(/谁记的/.test(bookMode), false)
  const { module } = loadClient()
  const empty = module.__test.ActorBoard({ actors: [], onRename: () => {} })
  assert.match(texts(empty).join(' | '), /这段时间没有人记过账/)
})
/** Load the bundle with a DOM and a react-dom stub, the way a browser would. */
function loadClientInBrowser() {
  const appended = []
  const removed = []
  const rendered = []
  const roots = []
  const document = {
    getElementById: () => null,
    createElement: (tag) => ({ tag, id: '', appendChild() {}, remove() { removed.push(this) } }),
    body: { appendChild: (node) => { appended.push(node); return node } },
  }
  const reactDom = {
    createRoot: (host) => {
      const root = {
        render: (element) => { rendered.push(element) },
        unmount: () => { roots.push('unmounted') },
      }
      roots.push({ host })
      return root
    },
  }
  let entry = null
  const sandbox = { window: { __ModuleLoader__: { load: (value) => { entry = value } } }, document }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  const react = fakeReact()
  const module = entry.factory((name) => {
    if (name === 'react') return react
    if (name === 'react-dom/client') return reactDom
    throw new Error('unexpected require: ' + name)
  })
  return { module, appended, removed, rendered, roots, document }
}

test('the dock mounts into its own body node, and is torn down with the plugin', () => {
  const browser = loadClientInBrowser()
  const disposers = []
  const ctx = {
    slots: {
      inject: (name, run) => run(),
      register: () => {},
    },
    effect: (fn) => { disposers.push(fn) },
  }
  browser.module.apply(ctx)
  assert.equal(browser.appended.length, 1, 'exactly one host node')
  assert.equal(browser.appended[0].id, 'dsh-ledger-dock-root')
  assert.equal(browser.appended[0].tag, 'div')
  assert.equal(browser.rendered.length, 1, 'something was rendered into it')
  assert.equal(disposers.length, 1, 'the plugin registers an effect')
  // cordis calls the effect callback and keeps the disposer it returns.
  const dispose = disposers[0]()
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(browser.roots.at(-1), 'unmounted', 'the React root is unmounted')
  assert.equal(browser.removed.length, 1, 'and the node is gone')
})

test('without a DOM the plugin still registers its settings section', () => {
  const { module } = loadClient()
  let registered = 0
  module.apply({ slots: { inject: (name, run) => run(), register: () => { registered += 1 } } })
  assert.equal(registered, 1)
})

test('every bar carries its exact numbers in a hover tooltip', () => {
  const tree = openDock(fullPayload())
  const rendered = texts(tree).join(' | ')
  // the day with spending: 12.00 out, nothing in, one entry
  assert.match(rendered, /10-05\n支出 ¥12\.00\n1 笔/)
  // the day money came in says so, and the empty days admit zero
  assert.match(rendered, /10-10\n支出 ¥0\.00\n收入 ¥300\.00\n1 笔/)
  assert.match(rendered, /10-01\n支出 ¥0\.00\n0 笔/)
  const stacked = texts(openDock(actorPayload(), { view: dockView({ group: 'actor' }) })).join(' | ')
  assert.match(stacked, /2026-10-05 · ¥12\.00\n妈 ¥12\.00/)
  assert.match(stacked, /2026-10-09 · ¥3\.00\n微信用户·o9cq806i ¥3\.00/)
})
