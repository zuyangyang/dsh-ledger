import assert from 'node:assert/strict'
import test from 'node:test'

import { addDays, daysBetween, parseDate } from '../lib/parse/date.js'

// 2026-10-26 is a Monday in Asia/Shanghai. The clock is always injected.
const MON = new Date('2026-10-26T10:00:00+08:00')
const FRI = new Date('2026-10-30T10:00:00+08:00')
const EARLY = new Date('2026-10-26T02:30:00+08:00')

function ok(text, date, source, now = MON) {
  const result = parseDate(text, { now })
  assert.equal(result.ok, true, text + ' should parse, got ' + JSON.stringify(result))
  assert.equal(result.date, date, text + ' date')
  if (source) assert.equal(result.source, source, text + ' source')
  return result
}

function bad(text, code, now = MON) {
  const result = parseDate(text, { now })
  assert.equal(result.ok, false, text + ' should be refused')
  assert.equal(result.code, code, text + ' code')
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.length > 0)
  return result
}

test('no date means today, inferred', () => {
  ok('', '2026-10-26', 'inferred_today')
  ok(null, '2026-10-26', 'inferred_today')
  ok('买了菜', '2026-10-26', 'inferred_today')
})

test('today and 刚才 are this calendar day during the day', () => {
  ok('今天', '2026-10-26', 'explicit_relative')
  ok('刚才', '2026-10-26', 'explicit_relative')
})

test('昨天 / 前天 / 大前天 count back three days', () => {
  ok('昨天', '2026-10-25', 'explicit_relative')
  ok('前天', '2026-10-24', 'explicit_relative')
  ok('大前天', '2026-10-23', 'explicit_relative')
  ok('昨天下午', '2026-10-25', 'explicit_relative')
})

test('上周三 is the Wednesday of the previous natural week', () => {
  ok('上周三', '2026-10-21', 'weekday')
  ok('上星期三', '2026-10-21', 'weekday')
  ok('上礼拜三', '2026-10-21', 'weekday')
  ok('上周日', '2026-10-25', 'weekday')
})

test('a weekday still in the future is refused, not guessed', () => {
  bad('这周三', 'E_DATE_FUTURE')
  bad('周三', 'E_DATE_FUTURE')
  bad('周五', 'E_DATE_FUTURE')
})

test('a weekday that already passed resolves inside this week', () => {
  ok('周三', '2026-10-28', 'weekday', FRI)
  ok('周一', '2026-10-26', 'weekday', FRI)
  ok('本周一', '2026-10-26', 'weekday')
})

test('absolute month/day resolves in the current year', () => {
  ok('9月3日', '2026-09-03', 'explicit_absolute')
  ok('9.3', '2026-09-03', 'explicit_absolute')
  ok('9/3', '2026-09-03', 'explicit_absolute')
  ok('10月26号', '2026-10-26', 'explicit_absolute')
})

test('a month/day in the future rolls back one year', () => {
  ok('12月31日', '2025-12-31', 'explicit_absolute')
  ok('12.31', '2025-12-31', 'explicit_absolute')
})

test('explicit month offsets', () => {
  ok('上个月12号', '2026-09-12', 'explicit_absolute')
  ok('本月5号', '2026-10-05', 'explicit_absolute')
  bad('上个月31号', 'E_DATE_INVALID') // September has 30 days
  bad('本月31号', 'E_DATE_FUTURE') // October has 31 days, but it is still ahead
})

test('an ISO date is used directly', () => {
  ok('2026-09-03', '2026-09-03', 'explicit_absolute')
  ok('2026-10-27', '2026-10-27', 'explicit_absolute') // +1 tolerates a timezone edge
  bad('2026-10-28', 'E_DATE_FUTURE')
  bad('1999-12-31', 'E_DATE_INVALID')
})

test('future wording is refused', () => {
  bad('明天', 'E_DATE_FUTURE')
  bad('后天', 'E_DATE_FUTURE')
  bad('下周', 'E_DATE_FUTURE')
  bad('下周三', 'E_DATE_FUTURE')
  bad('下个星期三', 'E_DATE_FUTURE')
  bad('明年1月', 'E_DATE_FUTURE')
})

test('impossible dates are invalid, not silently repaired', () => {
  bad('2月30日', 'E_DATE_INVALID')
  bad('2月29日', 'E_DATE_INVALID') // 2026 is not a leap year
  bad('2026-13-01', 'E_DATE_INVALID')
  bad('9月', 'E_DATE_INVALID')
})

test('the day cutoff pushes 刚才 back a day for a late-night snack', () => {
  ok('刚才', '2026-10-25', 'explicit_relative', EARLY)
  ok('夜宵摊', '2026-10-25', 'inferred_today', EARLY)
  ok('凌晨三点', '2026-10-25', 'inferred_today', EARLY)
})

test('the cutoff is configurable and can be disabled', () => {
  const result = parseDate('刚才', { now: EARLY, dayCutoffHour: 0 })
  assert.equal(result.date, '2026-10-26')
  const shifted = parseDate('刚才', { now: EARLY, dayCutoffHour: 6 })
  assert.equal(shifted.date, '2026-10-25')
})

test('addDays crosses month, year and leap boundaries', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2024-02-28', 1), '2024-02-29')
  assert.equal(addDays('2026-10-26', 55), '2026-12-20')
})

test('daysBetween is signed and integer', () => {
  assert.equal(daysBetween('2026-09-01', '2026-10-26'), 55)
  assert.equal(daysBetween('2026-10-26', '2026-09-01'), -55)
  assert.equal(daysBetween('2026-10-26', '2026-10-26'), 0)
  assert.ok(Number.isNaN(daysBetween('not-a-date', '2026-10-26')))
})
