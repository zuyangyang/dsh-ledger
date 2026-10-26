import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LedgerStore, peekJournal } from '../lib/store.js'

const quiet = { warn: () => {} }

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-store-'))
  return { dir, store: new LedgerStore({ dataDir: dir, logger: quiet }).init() }
}

function record(overrides = {}) {
  return {
    id: 'tx_a', schema: 2, version: 1, kind: 'expense', status: 'confirmed',
    book: 'home', amount_minor: 3200, currency: 'CNY', occurred_on: '2026-10-25',
    created_at: '2026-10-25T12:00:00+08:00', updated_at: '2026-10-25T12:00:00+08:00',
    request_id: 'req_a', ...overrides,
  }
}

test('append then reload keeps the record', () => {
  const { dir, store } = freshStore()
  store.append([record()])
  const again = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  assert.equal(again.all().length, 1)
  assert.equal(again.get('tx_a').amount_minor, 3200)
})

test('a repeated request_id is reported and not written twice', () => {
  const { store } = freshStore()
  store.append([record()])
  const second = store.append([record({ id: 'tx_b' })])
  assert.equal(second.written.length, 0)
  assert.equal(second.duplicates.length, 1)
  assert.equal(store.all().length, 1)
})

test('revision appends a new version and keeps history on disk', () => {
  const { dir, store } = freshStore()
  store.append([record()])
  const { before, after } = store.revise('tx_a', { amount_minor: 3500 })
  assert.equal(before.amount_minor, 3200)
  assert.equal(after.version, 2)
  assert.equal(store.get('tx_a').amount_minor, 3500)
  const lines = readFileSync(join(dir, 'entries.ndjson'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
})

test('a stale expectedVersion is refused', () => {
  const { store } = freshStore()
  store.append([record()])
  store.revise('tx_a', { amount_minor: 3500 })
  assert.throws(() => store.revise('tx_a', { amount_minor: 3600 }, { expectedVersion: 1 }), /changed meanwhile/)
})

test('malformed lines are quarantined, not repaired', () => {
  const { dir, store } = freshStore()
  store.append([record()])
  const path = join(dir, 'entries.ndjson')
  writeFileSync(path, readFileSync(path, 'utf8') + '{"id":"tx_bad"\n' + JSON.stringify({ id: 'tx_x' }) + '\n')
  const reloaded = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  assert.equal(reloaded.all().length, 1)
  assert.equal(reloaded.quarantined.length, 2)
  const files = readdirSync(join(dir, 'quarantine'))
  assert.equal(files.length, 1)
})

test('the highest version wins regardless of line order', () => {
  const { dir } = freshStore()
  const v2 = record({ version: 2, amount_minor: 9999 })
  const v1 = record({ version: 1, amount_minor: 100 })
  writeFileSync(join(dir, 'entries.ndjson'), [v2, v1].map((r) => JSON.stringify(r)).join('\n') + '\n')
  const store = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  assert.equal(store.get('tx_a').amount_minor, 9999)
})

test('records come back in (date, created_at, id) order', () => {
  const { store } = freshStore()
  store.append([
    record({ id: 'tx_late', occurred_on: '2026-10-26', created_at: '2026-10-26T18:00:00+08:00', request_id: 'req_1' }),
    record({ id: 'tx_early', occurred_on: '2026-10-01', request_id: 'req_2' }),
    record({ id: 'tx_same', occurred_on: '2026-10-26', created_at: '2026-10-26T09:00:00+08:00', request_id: 'req_3' }),
  ])
  assert.deepEqual(store.all().map((r) => r.id), ['tx_early', 'tx_same', 'tx_late'])
})

test('meta round-trips and remembers the last book per actor', () => {
  const { dir, store } = freshStore()
  store.rememberBookForActor('妈', 'shop')
  store.rememberBookForActor('yang', 'home')
  const reloaded = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  assert.equal(reloaded.lastBookForActor('妈'), 'shop')
  assert.equal(reloaded.lastBookForActor('yang'), 'home')
  assert.equal(reloaded.lastBookForActor('nobody'), null)
})

test('an unreadable meta file falls back to defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-meta-'))
  writeFileSync(join(dir, 'meta.json'), '{ not json')
  const store = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  assert.deepEqual(store.meta.lastBookByActor, {})
})

test('invalid records are refused at the door', () => {
  const { store } = freshStore()
  assert.throws(() => store.append([record({ kind: 'gift' })]), /invalid record: bad-kind/)
})

test('stats count entries and bytes', () => {
  const { store } = freshStore()
  store.append([record()])
  const stats = store.stats()
  assert.equal(stats.entries, 1)
  assert.ok(stats.bytes > 0)
})
test('peekJournal counts another directory without creating it', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ledger-peek-empty-'))
  const peekedEmpty = peekJournal(empty)
  assert.equal(peekedEmpty.exists, false)
  assert.equal(peekedEmpty.entries, 0)

  const used = mkdtempSync(join(tmpdir(), 'ledger-peek-'))
  writeFileSync(join(used, 'entries.ndjson'), '{"id":"a"}\n\n{"id":"b"}\n')
  const peeked = peekJournal(used)
  assert.equal(peeked.exists, true)
  assert.equal(peeked.entries, 2)

  const missing = join(tmpdir(), 'ledger-does-not-exist-' + Date.now())
  const peekedMissing = peekJournal(missing)
  assert.equal(peekedMissing.exists, false)
  assert.equal(readdirSync(tmpdir()).includes(missing.split('/').pop()), false)
})
test('a write from another process shows up without reopening', () => {
  // The dashboard is served by the host while the tools run in the session
  // process, so the reader must never trust a snapshot from activation time.
  const { dir, store } = freshStore()
  assert.equal(store.all().length, 0)
  const writer = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  writer.append([record({ id: 'tx_from_phone', request_id: 'req_phone' })])
  assert.equal(store.all().length, 1, 'reader sees the phone entry immediately')
  assert.equal(store.get('tx_from_phone').id, 'tx_from_phone')
  assert.equal(store.stats().entries, 1)
  // And it must not see the same line twice after its own append.
  store.append([record({ id: 'tx_local', request_id: 'req_local' })])
  assert.equal(store.all().length, 2)
})

test('a hand-edited journal line is picked up on the next read', () => {
  const { dir, store } = freshStore()
  store.append([record({ id: 'tx_a' })])
  appendFileSync(join(dir, 'entries.ndjson'), JSON.stringify(record({ id: 'tx_manual', request_id: 'req_manual' })) + '\n')
  assert.equal(store.all().length, 2)
})

test('meta written by another process is reloaded', () => {
  const { dir, store } = freshStore()
  assert.deepEqual(store.all(), [])
  const other = new LedgerStore({ dataDir: dir, logger: quiet }).init()
  other.patchMeta({ brief: false, lastBookByActor: { Mei: 'shop' } })
  store.all() // any read refreshes meta too
  assert.equal(store.meta.brief, false)
  assert.equal(store.lastBookForActor('Mei'), 'shop')
})

test('a repeated read that finds nothing new keeps the same records', () => {
  const { store } = freshStore()
  store.append([record()])
  const first = store.all()
  const second = store.all()
  assert.equal(first, second, 'no reload when the file did not change')
})

test('quarantine is reported after a foreign bad line appears', () => {
  const { dir, store } = freshStore()
  store.append([record()])
  appendFileSync(join(dir, 'entries.ndjson'), '{ not json\n')
  assert.equal(store.all().length, 1)
  assert.equal(store.stats().quarantined, 1)
})