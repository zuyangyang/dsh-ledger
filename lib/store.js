/**
 * The journal: one append-only NDJSON file holding every record of every book.
 *
 * Rules (DESIGN.md 4.3):
 * - appends only; a correction is a new line with version + 1
 * - a malformed line is quarantined, never repaired in place
 * - the in-memory index keeps the highest version per id
 * @module dsh-ledger/store
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, writeFileSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { compareRecords, shanghaiIso } from './util.js'
import { validateStoredRecord } from './events.js'

export const ENTRIES_FILE = 'entries.ndjson'
export const META_FILE = 'meta.json'

/**
 * How many journal lines live in a directory, without creating or touching it.
 * Used to tell the user where their old history still is after a move.
 * @param {string} dataDir
 * @returns {{dir: string, entries: number, exists: boolean}}
 */
export function peekJournal(dataDir) {
  const path = join(dataDir, ENTRIES_FILE)
  if (!existsSync(path)) return { dir: dataDir, entries: 0, exists: false }
  try {
    const text = readFileSync(path, 'utf8')
    const entries = text.split('\n').filter((line) => line.trim().length > 0).length
    return { dir: dataDir, entries, exists: true }
  } catch {
    return { dir: dataDir, entries: 0, exists: true }
  }
}

const DEFAULT_META = {
  schema: 1,
  categories: [],
  aliases: {},
  actors: {},
  lastBookByActor: {},
  brief: true,
}

export class LedgerStore {
  /**
   * @param {{dataDir: string, logger?: {warn: Function, info?: Function}}} options
   */
  constructor({ dataDir, logger = console }) {
    this.dataDir = dataDir
    this.logger = logger
    this.entriesPath = join(dataDir, ENTRIES_FILE)
    this.metaPath = join(dataDir, META_FILE)
    this.quarantineDir = join(dataDir, 'quarantine')
    /** @type {Map<string, object>} */
    this.index = new Map()
    /** @type {object[]} */
    this.records = []
    this.meta = { ...DEFAULT_META }
    this.quarantined = []
    this.loaded = false
    /** Size of the journal when we last read it; the file is the source of truth. */
    this.entriesSize = -1
    /** mtime of meta.json when we last read it. */
    this.metaMtimeMs = -1
  }

  /**
   * Another process may have appended since we last looked: the dashboard is
   * served by the host while the tools run in the session process, and a phone
   * message can land at any moment. Re-read when the file changed rather than
   * trusting a snapshot that was true at activation.
   */
  refreshIfChanged() {
    if (!this.loaded) return this.init()
    let size = -1
    try {
      size = statSync(this.entriesPath).size
    } catch {
      return this
    }
    if (size !== this.entriesSize) this.loadEntries()
    try {
      const metaMtimeMs = statSync(this.metaPath).mtimeMs
      if (metaMtimeMs !== this.metaMtimeMs) this.loadMeta()
    } catch {
      // No meta yet: defaults are already in place.
    }
    return this
  }

  /** Create the directory, load the journal, quarantine what cannot be parsed. */
  init() {
    if (this.loaded) return this
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    if (!existsSync(this.entriesPath)) writeFileSync(this.entriesPath, '', { encoding: 'utf8', mode: 0o600 })
    this.loadMeta()
    this.loadEntries()
    this.loaded = true
    return this
  }

  loadMeta() {
    this.metaMtimeMs = -1
    if (!existsSync(this.metaPath)) {
      this.meta = { ...DEFAULT_META }
      return
    }
    try {
      this.meta = { ...DEFAULT_META, ...(JSON.parse(readFileSync(this.metaPath, 'utf8')) ?? {}) }
      this.metaMtimeMs = statSync(this.metaPath).mtimeMs
    } catch (error) {
      this.logger?.warn?.('[ledger] meta.json unreadable, using defaults:', error?.message ?? error)
      this.meta = { ...DEFAULT_META }
    }
  }

  loadEntries() {
    const text = readFileSync(this.entriesPath, 'utf8')
    this.entriesSize = Buffer.byteLength(text, 'utf8')
    const lines = text.split('\n')
    this.index = new Map()
    this.quarantined = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        this.quarantined.push({ line: i + 1, reason: 'unparsable-json', raw: line })
        continue
      }
      const verdict = validateStoredRecord(parsed)
      if (!verdict.ok) {
        this.quarantined.push({ line: i + 1, reason: verdict.reason, raw: line })
        continue
      }
      const previous = this.index.get(parsed.id)
      if (!previous || parsed.version >= previous.version) this.index.set(parsed.id, parsed)
    }
    this.records = [...this.index.values()].sort(compareRecords)
    if (this.quarantined.length > 0) this.writeQuarantine()
  }

  writeQuarantine() {
    try {
      mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 })
      const path = join(this.quarantineDir, 'quarantine-' + shanghaiIso().replace(/[:+]/g, '') + '.ndjson')
      const body = this.quarantined.map((row) => JSON.stringify({ at: shanghaiIso(), ...row })).join('\n') + '\n'
      writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 })
      this.logger?.warn?.('[ledger] quarantined ' + this.quarantined.length + ' journal line(s) -> ' + path)
    } catch (error) {
      this.logger?.warn?.('[ledger] could not write quarantine file:', error?.message ?? error)
    }
  }

  /** All live-or-void records, highest version each, in total order. */
  all() {
    this.refreshIfChanged()
    return this.records
  }

  get(id) {
    this.refreshIfChanged()
    return this.index.get(id) ?? null
  }

  findByRequestId(requestId) {
    if (!requestId) return null
    this.refreshIfChanged()
    for (const record of this.records) {
      if (record.request_id === requestId) return record
    }
    return null
  }

  /**
   * Append records. A record whose request_id is already stored is skipped and
   * reported, so a retried tool call cannot double-charge.
   * @param {object[]} incoming
   */
  append(incoming) {
    this.refreshIfChanged()
    const written = []
    const duplicates = []
    for (const record of incoming) {
      const verdict = validateStoredRecord(record)
      if (!verdict.ok) throw new Error('refusing to write an invalid record: ' + verdict.reason)
      if (record.request_id) {
        const seen = this.findByRequestId(record.request_id)
        if (seen) {
          duplicates.push({ id: seen.id, request_id: record.request_id, occurred_on: seen.occurred_on })
          continue
        }
      }
      written.push(record)
    }
    if (written.length === 0) return { written: [], duplicates }
    const body = written.map((record) => JSON.stringify(record)).join('\n') + '\n'
    const fd = openSync(this.entriesPath, 'a', 0o600)
    try {
      writeSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    for (const record of written) {
      this.index.set(record.id, record)
      this.records.push(record)
    }
    this.records.sort(compareRecords)
    this.entriesSize = statSync(this.entriesPath).size
    return { written, duplicates }
  }

  /**
   * Append a new version of an existing record. History is kept; nothing is
   * ever removed from the file.
   */
  revise(id, patch, { expectedVersion } = {}) {
    this.refreshIfChanged()
    const current = this.index.get(id)
    if (!current) throw new Error('no such entry: ' + id)
    if (Number.isInteger(expectedVersion) && current.version !== expectedVersion) {
      throw new Error('entry changed meanwhile (expected v' + expectedVersion + ', found v' + current.version + ')')
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      version: current.version + 1,
      updated_at: shanghaiIso(),
    }
    const body = JSON.stringify(next) + '\n'
    const fd = openSync(this.entriesPath, 'a', 0o600)
    try {
      writeSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.index.set(next.id, next)
    this.records = this.records.filter((record) => record.id !== next.id)
    this.records.push(next)
    this.records.sort(compareRecords)
    this.entriesSize = statSync(this.entriesPath).size
    return { before: current, after: next }
  }

  saveMeta() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const tmp = this.metaPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.meta, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.metaPath)
    this.metaMtimeMs = statSync(this.metaPath).mtimeMs
    return this.meta
  }

  patchMeta(patch) {
    this.meta = { ...this.meta, ...patch }
    return this.saveMeta()
  }

  rememberBookForActor(actor, book) {
    if (!actor) return
    const map = { ...(this.meta.lastBookByActor || {}) }
    if (map[actor] === book) return
    map[actor] = book
    this.patchMeta({ lastBookByActor: map })
  }

  lastBookForActor(actor) {
    return (this.meta.lastBookByActor || {})[actor] ?? null
  }

  stats() {
    this.refreshIfChanged()
    return {
      dataDir: this.dataDir,
      entries: this.records.length,
      quarantined: this.quarantined.length,
      bytes: existsSync(this.entriesPath) ? readFileSync(this.entriesPath).length : 0,
    }
  }
}