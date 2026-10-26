/**
 * Identifier derivation. The model never supplies these (see DESIGN.md 4.5).
 * @module dsh-ledger/ids
 */

import { randomBytes } from 'node:crypto'
import { sha256hex } from './util.js'

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

function base32(bytes, length) {
  let out = ''
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += ALPHABET[bytes[i] % 32]
  }
  return out.slice(0, length)
}

/** Sortable transaction id: tx_<time36><random>. */
export function newTxId(now = new Date()) {
  return 'tx_' + now.getTime().toString(36) + base32(randomBytes(6), 6)
}

/**
 * Idempotency key derived from what the model can actually see. Repeats of the
 * same message (retry, replay, double submit) collapse onto one key.
 */
export function deriveRequestId({ sessionId, messageId, toolName, itemIndex, payloadHash }) {
  return 'req_' + sha256hex(
    [sessionId || '', messageId || '', toolName || '', String(itemIndex ?? ''), payloadHash || ''].join('|'),
    12,
  )
}

/** Content grouping key: same money, same day, same counterpart, same note. */
export function deriveDedupeKey({ kind, amountMinor, occurredOn, merchant, customer, note }) {
  return sha256hex(
    [kind, amountMinor, occurredOn, merchant || '', customer || '', (note || '').trim()].join('|'),
    16,
  )
}
