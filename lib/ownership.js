/**
 * Who owns a record, as a side table.
 *
 * Ownership is deliberately not in the journal. Records written before
 * dsh-family-auth existed have no owner, and rewriting the journal to add one
 * would double its length for a purely administrative fact. A side file can be
 * migrated, corrected and (if the whole idea is abandoned) deleted without
 * touching the accounting history at all.
 *
 * Same discipline as the journal: append-only, last line wins, one record per
 * line so a torn write costs one entry and never the file.
 * @module dsh-ledger/ownership
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const OWNERSHIP_FILE = 'ownership.ndjson'

/**
 * Owner of anything nobody claimed. Matches dsh-family-auth's shared bucket, so
 * a record written before anyone was identified is readable by the household
 * rather than lost or private to a guess.
 */
export const DEFAULT_OWNER = 'default'

/** @param {string} dataDir - ledger directory. */
export function ownershipPath(dataDir) {
  return join(dataDir, OWNERSHIP_FILE)
}

/**
 * Read the side table.
 * @param {string} dataDir - ledger directory.
 * @returns {Map<string, string>} record id to owner id.
 */
export function loadOwnership(dataDir) {
  const map = new Map()
  const file = ownershipPath(dataDir)
  if (!existsSync(file)) return map
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return map
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const entry = JSON.parse(trimmed)
      if (entry && typeof entry.recordId === 'string' && typeof entry.ownerId === 'string') {
        map.set(entry.recordId, entry.ownerId)
      }
    } catch {
      // A half-written tail is skipped; the journal stays authoritative.
    }
  }
  return map
}

/**
 * Append ownership facts.
 * @param {string} dataDir - ledger directory.
 * @param {object[]} entries - `{ recordId, ownerId, at, by, reason }`.
 * @returns {number} how many were written.
 */
export function appendOwnership(dataDir, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0
  mkdirSync(dataDir, { recursive: true })
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  appendFileSync(ownershipPath(dataDir), body, { encoding: 'utf8' })
  return entries.length
}

/**
 * Resolve the owner of one record.
 *
 * The side table wins over the inline field: an entry there is an explicit
 * decision made later by the owner ("these old ones are mine"), while the inline
 * field is only the guess made at write time. Without that order a record that
 * an anonymous session wrote as `default` could never be claimed by anyone.
 * @param {object} record - journal record.
 * @param {Map<string, string>} [ownership] - side table.
 * @returns {string} owner id.
 */
export function ownerOf(record, ownership) {
  if (!record || typeof record !== 'object') return DEFAULT_OWNER
  const mapped = ownership?.get(record.id)
  if (typeof mapped === 'string' && mapped.length > 0) return mapped
  if (typeof record.ownerId === 'string' && record.ownerId.length > 0) return record.ownerId
  return DEFAULT_OWNER
}
