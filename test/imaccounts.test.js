import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createImAccountNames } from '../lib/imaccounts.js'

const quiet = { warn() {}, debug() {} }

function configFile(dir, value) {
  const path = join(dir, 'workspaces.json')
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

test('the name dsh-im shows for an account comes back from its bot id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const path = configFile(dir, {
    version: 2,
    workspaces: { wx_a: '/tmp/one', wx_b: '/tmp/two' },
    aliases: { wx_a: 'Yang', wx_b: 'Mei' },
  })
  const names = createImAccountNames({ path, logger: quiet })
  assert.equal(names.nameFor('wx_a'), 'Yang')
  assert.equal(names.nameFor('wx_b'), 'Mei')
  assert.equal(names.nameFor('wx_missing'), null)
  assert.equal(names.nameFor(null), null)
  assert.equal(names.nameFor(''), null)
})

test('a missing or broken config is not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const missing = createImAccountNames({ path: join(dir, 'nope.json'), logger: quiet })
  assert.equal(missing.nameFor('wx_a'), null)
  const broken = createImAccountNames({ path: configFile(dir, '{not json'), logger: quiet })
  assert.equal(broken.nameFor('wx_a'), null)
  const shapeless = createImAccountNames({ path: configFile(dir, { version: 2 }), logger: quiet })
  assert.equal(shapeless.nameFor('wx_a'), null)
})

test('aliases that are blank or not strings are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const path = configFile(dir, { aliases: { wx_a: '  ', wx_b: 'Mei', wx_c: 42, wx_d: null } })
  const names = createImAccountNames({ path, logger: quiet })
  assert.equal(names.nameFor('wx_a'), null)
  assert.equal(names.nameFor('wx_b'), 'Mei')
  assert.equal(names.nameFor('wx_c'), '42')
  assert.equal(names.nameFor('wx_d'), null)
})

test('renaming an account in dsh-im shows up without a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const path = configFile(dir, { aliases: { wx_a: 'Yang' } })
  const names = createImAccountNames({ path, logger: quiet })
  assert.equal(names.nameFor('wx_a'), 'Yang')
  // Same file, new content and a later mtime: the cache must notice.
  writeFileSync(path, JSON.stringify({ aliases: { wx_a: '杨' } }))
  const later = new Date(Date.now() + 5000)
  utimesSync(path, later, later)
  assert.equal(names.nameFor('wx_a'), '杨')
})

test('disabled names are never used', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-im-'))
  const path = configFile(dir, { aliases: { wx_a: 'Yang' } })
  const names = createImAccountNames({ path, enabled: false, logger: quiet })
  assert.equal(names.nameFor('wx_a'), null)
})

test('a relative-friendly blank path resolves to nothing', () => {
  const names = createImAccountNames({ path: '   ', logger: quiet })
  assert.equal(names.nameFor('wx_a'), null)
})
