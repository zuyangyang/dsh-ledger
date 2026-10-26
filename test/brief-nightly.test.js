import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildBrief } from '../lib/brief.js'
import { buildNightly, isDue, nightlyKey } from '../lib/nightly.js'
import { createRuntime } from '../lib/runtime.js'

const NOW = new Date('2026-10-26T21:40:00+08:00')
const quiet = { warn: () => {}, info: () => {} }

function setup(config = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-brief-'))
  const runtime = createRuntime({
    config: { dataDir, autoCommit: false, ...config },
    now: () => NOW,
    logger: quiet,
  })
  return runtime
}

function entry(overrides = {}) {
  return {
    id: 'tx_' + Math.random().toString(36).slice(2, 8),
    schema: 2, version: 1, kind: 'expense', status: 'confirmed', book: 'home',
    amount_minor: 3200, occurred_on: '2026-10-26', created_at: '2026-10-26T09:00:00+08:00',
    category: { l1: 'food', l2: null }, note: '午饭', paid_minor: 3200,
    ...overrides,
  }
}

test('the brief teaches the two books before there is any data', () => {
  const runtime = setup()
  const text = buildBrief(runtime)
  assert.match(text, /ledger_/)
  assert.match(text, /两本账/)
})

test('the brief states this month in one line, never as a final answer', () => {
  const runtime = setup()
  runtime.store.append([
    entry(),
    entry({ book: 'shop', kind: 'sale', amount_minor: 48000, paid_minor: 0, customer: '老陈', category: { l1: 'biz_revenue', l2: null } }),
  ])
  const text = buildBrief(runtime)
  assert.match(text, /家里支出 ¥32\.00/)
  assert.match(text, /店里卖出 ¥480\.00/)
  assert.match(text, /外面还欠 ¥480\.00/)
  assert.match(text, /别用这里的旧数当最终答案/)
})

test('an empty brief can be turned off', () => {
  const runtime = setup({ brief: false })
  assert.equal(buildBrief(runtime), '')
})

test('the night pass is not due before 21:30', () => {
  const config = { nightlyEnabled: true, nightlyTime: '21:30', nightlyShopDaily: true, nightlyHomeWeekly: 1 }
  const early = new Date('2026-10-26T21:00:00+08:00')
  assert.equal(isDue({ now: early, config, meta: { nightly: { sent: {} } } }), false)
  assert.equal(isDue({ now: NOW, config, meta: { nightly: { sent: {} } } }), true)
  assert.equal(isDue({ now: NOW, config, meta: { nightly: { sent: { [nightlyKey('2026-10-26', 'shop')]: 'x', [nightlyKey('2026-10-26', 'home')]: 'x' } } } }), false)
})

test('the night pass summarises the shop and marks itself sent exactly once', () => {
  const runtime = setup({ nightlyShopDaily: true, nightlyHomeWeekly: 1 })
  runtime.store.append([entry({ book: 'shop', kind: 'sale', amount_minor: 48000, paid_minor: 20000, customer: '老陈', category: { l1: 'biz_revenue', l2: null } })])
  const first = buildNightly({ runtime })
  assert.equal(first.messages.length, 1)
  assert.match(first.messages[0], /今天店里卖了 ¥480\.00/)
  assert.match(first.messages[0], /收到 ¥200\.00/)
  assert.match(first.messages[0], /赊出去 ¥280\.00/)
  const second = buildNightly({ runtime })
  assert.equal(second.messages.length, 0)
})

test('an empty day still marks the book done so it cannot fire later', () => {
  const runtime = setup({ nightlyShopDaily: true, nightlyHomeWeekly: 1 })
  const result = buildNightly({ runtime })
  assert.equal(result.messages.length, 0)
  assert.ok(runtime.store.meta.nightly.sent[nightlyKey('2026-10-26', 'shop')])
})

test('the household night line only fires on its configured weekday', () => {
  const runtime = setup({ nightlyShopDaily: false, nightlyHomeWeekly: 0 })
  runtime.store.append([entry()])
  const result = buildNightly({ runtime })
  assert.equal(result.messages.length, 0)
})
