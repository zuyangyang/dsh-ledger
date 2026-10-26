import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'

test('defaults match the design doc', () => {
  const c = normalizeConfig({})
  assert.equal(c.dayCutoffHour, 4)
  assert.equal(c.defaultBook, 'home')
  assert.equal(c.shopName, '店里')
  assert.equal(c.defaultActor, 'yang')
  assert.equal(c.purchaseSettlementDefault, 'cash')
  assert.equal(c.nightlyTime, '21:30')
  assert.equal(c.commitDebounceSec, 60)
  assert.equal(c.diag, false)
})

test('dataDir is expanded and absolute', () => {
  const c = normalizeConfig({ dataDir: '~/ledger' })
  assert.equal(c.dataDir.endsWith('/ledger'), true)
  assert.equal(c.dataDir.startsWith('/'), true)
})

test('bad values fall back instead of throwing', () => {
  const c = normalizeConfig({ nightlyTime: '25:99', dayCutoffHour: 99, briefMaxChars: 1, purchaseSettlementDefault: 'barter' })
  assert.equal(c.nightlyTime, '21:30')
  assert.equal(c.dayCutoffHour, 12)
  assert.equal(c.briefMaxChars, 120)
  assert.equal(c.purchaseSettlementDefault, 'cash')
})

test('only shop is a valid alternate default book', () => {
  assert.equal(normalizeConfig({ defaultBook: 'shop' }).defaultBook, 'shop')
  assert.equal(normalizeConfig({ defaultBook: 'mall' }).defaultBook, 'home')
})
