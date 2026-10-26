/**
 * Small helpers shared by every module. No I/O here.
 * @module dsh-ledger/util
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve a user-supplied directory to an absolute path.
 *
 * Accepts "~", "~/x", "$HOME/x", "${HOME}/x" and relative paths; a relative
 * path is taken from the home directory rather than the process cwd, because
 * the cwd of a DSH process is whatever the user last opened and would make the
 * journal appear to move on its own.
 */
export function expandHome(dir, home = homedir()) {
  if (typeof dir !== 'string') return resolve(home)
  const trimmed = dir.trim()
  if (trimmed.length === 0) return resolve(home)
  const expanded = trimmed.replace(/^~(?=$|[\/\\])/, home).replace(/\$\{?HOME\}?/g, home)
  return resolve(expanded.startsWith('/') ? expanded : join(home, expanded))
}

/** Hex sha256 of a string, truncated to n chars. */
export function sha256hex(text, n = 64) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, n)
}

/** ISO timestamp in Asia/Shanghai, second precision. */
export function shanghaiIso(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return (
    t.getUTCFullYear() + '-' + p(t.getUTCMonth() + 1) + '-' + p(t.getUTCDate()) +
    'T' + p(t.getUTCHours()) + ':' + p(t.getUTCMinutes()) + ':' + p(t.getUTCSeconds()) + '+08:00'
  )
}

/** Calendar date (YYYY-MM-DD) in Asia/Shanghai for an instant. */
export function shanghaiDate(date = new Date()) {
  return shanghaiIso(date).slice(0, 10)
}

/** Shanghai wall-clock hour (0-23) for an instant. */
export function shanghaiHour(date = new Date()) {
  return Number(shanghaiIso(date).slice(11, 13))
}

/** Integer division with half-up rounding, for minor units only. */
export function divRoundHalfUp(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1
  const n = Math.abs(numerator)
  const d = Math.abs(denominator)
  return sign * Math.floor((2 * n + d) / (2 * d))
}

/** Format minor units as a CNY amount with two decimals: 3200 -> "32.00". */
export function formatMinor(minor) {
  const n = Number(minor) || 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0')
}

/** "¥32.00" for humans, "-¥32.00" for negatives. */
export function formatMoney(minor) {
  const n = Number(minor) || 0
  return (n < 0 ? '-¥' : '¥') + formatMinor(Math.abs(n))
}

/** Sort key for the one true total order: (occurred_on, created_at, id). */
export function compareRecords(a, b) {
  if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? -1 : 1
  const ac = a.created_at || ''
  const bc = b.created_at || ''
  if (ac !== bc) return ac < bc ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** Parse YYYY-MM-DD into a UTC midnight timestamp (pure, no timezone drift). */
function dateMs(dateStr) {
  const [year, month, day] = String(dateStr).split('-').map(Number)
  return Date.UTC(year, (month || 1) - 1, day || 1)
}

/** Shift a YYYY-MM-DD string by n days. */
export function addDays(dateStr, n) {
  const shifted = new Date(dateMs(dateStr) + Number(n) * 86400000)
  return shifted.toISOString().slice(0, 10)
}

/** Whole days from a to b (b - a); negative when b is earlier. */
export function daysBetween(a, b) {
  return Math.round((dateMs(b) - dateMs(a)) / 86400000)
}

/** Stable, human-readable key for a value (used by dedupe keys). */
export function stableKey(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim().toLowerCase()
  return JSON.stringify(value)
}