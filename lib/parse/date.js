/**
 * Date parsing: the user's words in, one Asia/Shanghai calendar date out
 * (DESIGN.md 5.3). Everything is pure: the clock is always passed in as `now`,
 * the timezone is fixed at +08:00, and the day boundary is configurable.
 *
 *   { ok: true, date: '2026-10-25', source: 'explicit_relative' }
 *   { ok: false, code: 'E_DATE_FUTURE', message: '...' }
 *
 * Dates are plain 'YYYY-MM-DD' strings end to end, so callers can compare them
 * lexicographically. `addDays` / `daysBetween` work on those strings only.
 * @module dsh-ledger/parse/date
 */

import { shanghaiDate, shanghaiHour } from '../util.js'

const DAY_MS = 24 * 3600 * 1000

/** Weekday character -> Monday-based index (Mon=0 ... Sun=6). */
const WEEKDAY_INDEX = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
  1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6,
}

/** Substrings that mean "the night that is still yesterday" near the cutoff. */
const LATE_NIGHT_RE = /刚才|刚刚|刚|凌晨|夜宵/

/** Words that explicitly point at the future; the design refuses those (§5.3). */
const FUTURE_WORD_RE = /明天|明日|后天|大后天|明年|下周|下星期|下礼拜|下个月|下月/

const ISO_RE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/
const WEEKDAY_RE = /(上上|上|下|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天1-7])/
const LAST_MONTH_RE = /上个月|上月/
const THIS_MONTH_RE = /本月|这个月|这月/
const MONTH_DAY_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]?/
const DOT_DAY_RE = /(\d{1,2})\s*[./]\s*(\d{1,2})/
const DAY_IN_MONTH_RE = /(\d{1,2})\s*[号日]/

function fail(code, message) {
  return { ok: false, code, message }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 'YYYY-MM-DD' from numeric parts. */
function ymd(year, month, day) {
  return String(year) + '-' + pad2(month) + '-' + pad2(day)
}

/** Split 'YYYY-MM-DD' into numbers; null when it is not that shape. */
function parseYmd(dateStr) {
  if (typeof dateStr !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/** True only for real calendar dates (rejects 2 月 30 日). */
function isValidYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return dt.getUTCFullYear() === year && dt.getUTCMonth() + 1 === month && dt.getUTCDate() === day
}

/** UTC-midnight epoch for a date string; null when malformed. */
function utcEpoch(dateStr) {
  const p = parseYmd(dateStr)
  if (!p) return null
  return Date.UTC(p.year, p.month - 1, p.day)
}

/** 0=Sunday ... 6=Saturday, in UTC terms (Shanghai has no DST). */
function weekdayOf(dateStr) {
  const epoch = utcEpoch(dateStr)
  if (epoch === null) return null
  return new Date(epoch).getUTCDay()
}

/**
 * Add (or subtract) whole days to a 'YYYY-MM-DD' string.
 * Pure string-date arithmetic through UTC, so DST never enters the picture.
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {number} n days to add; negative goes back
 * @returns {string} 'YYYY-MM-DD'; the input unchanged when it is not a date
 */
export function addDays(dateStr, n) {
  const epoch = utcEpoch(dateStr)
  if (epoch === null || !Number.isInteger(n)) return dateStr
  const dt = new Date(epoch + n * DAY_MS)
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/**
 * Whole days from `a` to `b` (negative when b is earlier). Aging buckets
 * (DESIGN 8.8) are built on this, so it must stay integer.
 * @param {string} a 'YYYY-MM-DD'
 * @param {string} b 'YYYY-MM-DD'
 * @returns {number} days; NaN when either side is not a date
 */
export function daysBetween(a, b) {
  const from = utcEpoch(a)
  const to = utcEpoch(b)
  if (from === null || to === null) return NaN
  return Math.round((to - from) / DAY_MS)
}

/** Monday of the natural week containing `dateStr`. */
function mondayOf(dateStr) {
  const weekday = weekdayOf(dateStr) // 0=Sun
  return addDays(dateStr, -((weekday + 6) % 7))
}

/** Resolve a weekday reference relative to the current natural week. */
function resolveWeekday(prefix, char, today) {
  const index = WEEKDAY_INDEX[char]
  if (index === undefined) return fail('E_DATE_INVALID', '这个星期几看不懂')
  const monday = mondayOf(today)
  if (prefix === '下') return fail('E_DATE_FUTURE', '还不能记未来的日期；说说这是哪天的事')
  if (prefix === '上') return okDate(addDays(monday, -7 + index), 'weekday')
  if (prefix === '上上') return okDate(addDays(monday, -14 + index), 'weekday')
  // 这/本/bare: this natural week, Monday first. Future -> refuse, never guess.
  const target = addDays(monday, index)
  if (target > today) {
    return fail('E_DATE_FUTURE', '「' + prefix + '周' + char + '」还没到；说清是上周还是别的哪天')
  }
  return okDate(target, 'weekday')
}

function okDate(date, source) {
  return { ok: true, date, source }
}

/**
 * Absolute dates: accept through tomorrow (DESIGN 5.3 tolerates a timezone
 * boundary) but not beyond, and nothing before 2000-01-01.
 */
function checkAbsolute(date, today) {
  if (date < '2000-01-01') return fail('E_DATE_INVALID', '日期太早了（最早 2000-01-01）')
  if (date > addDays(today, 1)) return fail('E_DATE_FUTURE', '还不能记未来的日期；说说这是哪天的事')
  return okDate(date, 'explicit_absolute')
}

/** Resolve "9月3日"-style forms: current year, previous year when future. */
function resolveMonthDay(month, day, today) {
  const year = Number(today.slice(0, 4))
  if (!isValidYmd(year, month, day)) {
    return fail('E_DATE_INVALID', '这个日期不存在：' + month + ' 月 ' + day + ' 号')
  }
  let date = ymd(year, month, day)
  if (date > today) {
    if (!isValidYmd(year - 1, month, day)) {
      return fail('E_DATE_INVALID', '这个日期不存在：' + month + ' 月 ' + day + ' 号')
    }
    date = ymd(year - 1, month, day)
    // A bare month/day more than ~2 years back is almost certainly a missing year.
    if (daysBetween(date, today) > 730) {
      return fail('E_DATE_INVALID', '这个日期太早了，请带上年份（像 2024-09-03）')
    }
  }
  return okDate(date, 'explicit_absolute')
}

/**
 * Parse a date expression the way a person said it (DESIGN 5.3).
 *
 * Covered forms: 今天 / 刚才 / 昨天 / 前天 / 大前天 / 上周三 / 这周三 / 周三 /
 * 9月3日 / 9.3 / 9/3 / 上个月12号 / 本月5号 / 2026-09-03. No date means today.
 * "明天 / 下周 / 明年1月" are refused with E_DATE_FUTURE rather than guessed.
 *
 * Day boundary: when the local hour is below `dayCutoffHour` and the text says
 * 刚才 / 刚 / 凌晨 / 夜宵, "today" means the night that started yesterday
 * (the 夜宵 case in the design). No date at all also lands on inferred_today.
 *
 * @param {string} text raw date fragment ("昨天", "上周三", ...)
 * @param {{now?: Date, dayCutoffHour?: number}} [options] injected clock
 * @returns {{ok: true, date: string, source: 'inferred_today'|'explicit_relative'|'explicit_absolute'|'weekday'}
 *   | {ok: false, code: string, message: string}}
 */
export function parseDate(text, { now = new Date(), dayCutoffHour = 4 } = {}) {
  const raw = text === null || text === undefined ? '' : String(text).trim()
  const today = shanghaiDate(now)
  const localHour = shanghaiHour(now)
  const cutoff = Number(dayCutoffHour)
  const cutoffHour = Number.isFinite(cutoff) ? cutoff : 4
  const lateNight = localHour < cutoffHour && LATE_NIGHT_RE.test(raw)

  if (raw === '') return okDate(lateNight ? addDays(today, -1) : today, 'inferred_today')

  // 1. Explicit future semantics are always refused (§5.3).
  if (FUTURE_WORD_RE.test(raw)) {
    return fail('E_DATE_FUTURE', '还不能记未来的日期；说说这是哪天的事')
  }

  // 2. ISO / dotted absolute date (2026-09-03). Checked first so 9-3 does not
  //    get read as a month/day pair by mistake.
  let m = ISO_RE.exec(raw)
  if (m) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    if (!isValidYmd(year, month, day)) return fail('E_DATE_INVALID', '这个日期不存在：' + raw)
    return checkAbsolute(ymd(year, month, day), today)
  }

  // 3. Relative words. 大前天 must be tested before 前天, and 前天 before 天.
  if (/大前天/.test(raw)) return okDate(addDays(today, -3), 'explicit_relative')
  if (/前天/.test(raw)) return okDate(addDays(today, -2), 'explicit_relative')
  if (/昨天|昨日/.test(raw)) return okDate(addDays(today, -1), 'explicit_relative')
  if (/刚才|刚刚|刚/.test(raw)) {
    return okDate(lateNight ? addDays(today, -1) : today, 'explicit_relative')
  }
  if (/今天|今日|今晚|今儿|当天/.test(raw)) {
    return okDate(lateNight ? addDays(today, -1) : today, 'explicit_relative')
  }

  // 4. Weekday references.
  m = WEEKDAY_RE.exec(raw)
  if (m) return resolveWeekday(m[1] || '', m[2], today)

  // 5. Explicit month offsets.
  if (LAST_MONTH_RE.test(raw)) {
    const dayMatch = DAY_IN_MONTH_RE.exec(raw)
    if (!dayMatch) return fail('E_DATE_INVALID', '上个月几号？说个日子我再记')
    const day = Number(dayMatch[1])
    const month = Number(today.slice(5, 7))
    const year = Number(today.slice(0, 4))
    const targetYear = month === 1 ? year - 1 : year
    const targetMonth = month === 1 ? 12 : month - 1
    if (!isValidYmd(targetYear, targetMonth, day)) return fail('E_DATE_INVALID', '上个月没有 ' + day + ' 号')
    return okDate(ymd(targetYear, targetMonth, day), 'explicit_absolute')
  }
  if (THIS_MONTH_RE.test(raw)) {
    const dayMatch = DAY_IN_MONTH_RE.exec(raw)
    if (!dayMatch) return fail('E_DATE_INVALID', '这个月几号？说个日子我再记')
    const day = Number(dayMatch[1])
    const year = Number(today.slice(0, 4))
    const month = Number(today.slice(5, 7))
    if (!isValidYmd(year, month, day)) return fail('E_DATE_INVALID', '这个月没有 ' + day + ' 号')
    const date = ymd(year, month, day)
    if (date > today) return fail('E_DATE_FUTURE', '「本月 ' + day + ' 号」还没到；说清是哪天')
    return okDate(date, 'explicit_absolute')
  }

  // 6. Bare month/day: 9月3日, 9.3, 9/3.
  m = MONTH_DAY_RE.exec(raw)
  if (m) return resolveMonthDay(Number(m[1]), Number(m[2]), today)
  m = DOT_DAY_RE.exec(raw)
  if (m) return resolveMonthDay(Number(m[1]), Number(m[2]), today)

  // 7. A date word we cannot place (e.g. "9月") is refused, not defaulted.
  if (/月/.test(raw)) return fail('E_DATE_INVALID', '日期要带上几号，比如「9月3日」')

  // 8. Nothing date-like in the fragment: today, as the design defaults.
  return okDate(lateNight ? addDays(today, -1) : today, 'inferred_today')
}