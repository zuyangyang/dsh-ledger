import assert from 'node:assert/strict'
import test from 'node:test'

import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultDataDir, normalizeConfig } from '../lib/config.js'

test('defaults match the design doc', () => {
  const c = normalizeConfig({})
  assert.equal(c.dayCutoffHour, 4)
  assert.equal(c.defaultBook, 'home')
  assert.equal(c.shopName, '店里')
  assert.equal(c.purchaseSettlementDefault, 'cash')
  assert.equal(c.commitDebounceSec, 60)
  assert.equal(c.diag, false)
})

test('dataDir is expanded and absolute', () => {
  const c = normalizeConfig({ dataDir: '~/ledger' })
  assert.equal(c.dataDir.endsWith('/ledger'), true)
  assert.equal(c.dataDir.startsWith('/'), true)
})

test('the default journal is the one under the dsh home', () => {
  const c = normalizeConfig({})
  assert.equal(c.dataDir, join(homedir(), '.dsh', 'ledger'))
  assert.equal(c.defaultDataDir, c.dataDir)
  assert.equal(c.dataDirIsDefault, true)
  assert.equal(normalizeConfig({ dataDir: defaultDataDir() }).dataDirIsDefault, true)
})

test('two DSH homes never share one journal', () => {
  // The whole isolation story: a second profile sets its own DSH_HOME and gets
  // its own default directory without configuring anything.
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/home-a' }), join('/tmp/home-a', 'ledger'))
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/home-b' }), join('/tmp/home-b', 'ledger'))
  assert.notEqual(defaultDataDir({ DSH_HOME: '/tmp/home-a' }), defaultDataDir({ DSH_HOME: '/tmp/home-b' }))
  assert.equal(defaultDataDir({}), join(homedir(), '.dsh', 'ledger'))
  assert.equal(defaultDataDir({ DSH_HOME: '   ' }), join(homedir(), '.dsh', 'ledger'))
})

test('a custom directory may use ~, $HOME or a relative path', () => {
  const home = homedir()
  assert.equal(normalizeConfig({ dataDir: '~/Documents/Ledger' }).dataDir, join(home, 'Documents/Ledger'))
  assert.equal(normalizeConfig({ dataDir: '$HOME/账本' }).dataDir, join(home, '账本'))
  assert.equal(normalizeConfig({ dataDir: '${HOME}/账本' }).dataDir, join(home, '账本'))
  // A relative path hangs off the home directory, not the process cwd: a cwd
  // that changes with whatever project is open would move the journal.
  assert.equal(normalizeConfig({ dataDir: 'Documents/账本' }).dataDir, join(home, 'Documents/账本'))
  assert.equal(normalizeConfig({ dataDir: '  /tmp/ledger  ' }).dataDir, '/tmp/ledger')
  assert.equal(normalizeConfig({ dataDir: '~/Documents/Ledger' }).dataDirIsDefault, false)
})

test('an empty or odd dataDir still yields a usable absolute path', () => {
  for (const value of ['', '   ', undefined, null, 42]) {
    const c = normalizeConfig({ dataDir: value })
    assert.equal(c.dataDir.startsWith('/'), true)
    assert.equal(c.dataDir, join(homedir(), '.dsh', 'ledger'))
  }
})

test('bad values fall back instead of throwing', () => {
  const c = normalizeConfig({ dayCutoffHour: 99, briefMaxChars: 1, purchaseSettlementDefault: 'barter' })
  assert.equal(c.dayCutoffHour, 12)
  assert.equal(c.briefMaxChars, 120)
  assert.equal(c.purchaseSettlementDefault, 'cash')
})

test('only shop is a valid alternate default book', () => {
  assert.equal(normalizeConfig({ defaultBook: 'shop' }).defaultBook, 'shop')
  assert.equal(normalizeConfig({ defaultBook: 'mall' }).defaultBook, 'home')
})