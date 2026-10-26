import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  coerceSetting, describeSettings, mergeConfig, readUiConfig, saveUiConfig,
} from '../lib/uiconfig.js'

function tempPath() {
  return join(mkdtempSync(join(tmpdir(), 'ledger-ui-')), 'ledger-ui.json')
}

test('saved settings survive a restart', () => {
  const path = tempPath()
  const saved = saveUiConfig({ shopName: '皮鞋店', nightlyTime: '21:45', autoCommit: false }, path)
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.changed.sort(), ['autoCommit', 'nightlyTime', 'shopName'])
  const reloaded = readUiConfig(path)
  assert.equal(reloaded.values.shopName, '皮鞋店')
  assert.equal(reloaded.values.nightlyTime, '21:45')
  assert.equal(reloaded.values.autoCommit, false)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(parsed.version, 1)
})

test('panel values win over the deployment patch', () => {
  const merged = mergeConfig({ dataDir: '/deployment/ledger', shopName: '店里', defaultActor: 'yang' }, { shopName: '皮鞋店' })
  assert.equal(merged.shopName, '皮鞋店')
  assert.equal(merged.defaultActor, 'yang')
  assert.equal(merged.dataDir, '/deployment/ledger')
  // Keys the panel does not own are ignored even if someone injects them.
  assert.equal(mergeConfig({}, { dailyBudget: 100 }).dailyBudget, undefined)
})

test('bad values are refused instead of stored', () => {
  const path = tempPath()
  for (const [key, value] of [
    ['nightlyTime', '25:00'],
    ['dayCutoffHour', 99],
    ['defaultBook', 'office'],
    ['purchaseSettlementDefault', 'barter'],
    ['nightlyEnabled', 'yes'],
    ['madeUpKey', 'x'],
  ]) {
    const result = saveUiConfig({ [key]: value }, path)
    assert.equal(result.ok, false, key + ' should be refused')
  }
  assert.deepEqual(readUiConfig(path).values, {})
})

test('clearing a key removes the override', () => {
  const path = tempPath()
  saveUiConfig({ shopName: '皮鞋店', nightlyEnabled: false }, path)
  saveUiConfig({ shopName: '' }, path)
  const values = readUiConfig(path).values
  assert.equal('shopName' in values, false)
  assert.equal(values.nightlyEnabled, false)
})

test('a corrupted file is an empty set, not a crash', () => {
  const path = tempPath()
  writeFileSync(path, '{ not json')
  const read = readUiConfig(path)
  assert.deepEqual(read.values, {})
  assert.equal(read.broken, true)
  // Unknown keys already in the file are dropped on read.
  writeFileSync(path, JSON.stringify({ version: 1, values: { madeUpKey: 1, shopName: '皮鞋店' } }))
  assert.deepEqual(readUiConfig(path).values, { shopName: '皮鞋店' })
})

test('coerceSetting normalises numbers and trims strings', () => {
  assert.deepEqual(coerceSetting('commitDebounceSec', '90'), { ok: true, value: 90 })
  assert.deepEqual(coerceSetting('dataDir', '  ~/ledger  '), { ok: true, value: '~/ledger' })
  assert.equal(coerceSetting('dayCutoffHour', 4.5).ok, false)
})

test('the panel is told where each value came from', () => {
  const settings = describeSettings({ base: { shopName: '店里', defaultActor: 'yang' }, overrides: { shopName: '皮鞋店' } })
  const shop = settings.find((setting) => setting.key === 'shopName')
  assert.equal(shop.value, '皮鞋店')
  assert.equal(shop.source, 'ui')
  const actor = settings.find((setting) => setting.key === 'defaultActor')
  assert.equal(actor.source, 'deployment')
  const nightly = settings.find((setting) => setting.key === 'nightlyTime')
  assert.equal(nightly.source, 'default')
  assert.equal(settings.every((setting) => typeof setting.label === 'string' && setting.label.length > 0), true)
})
