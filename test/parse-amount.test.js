import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAmount } from '../lib/parse/amount.js'

/** Assert a successful parse and return the result for extra checks. */
function ok(text, minor) {
  const result = parseAmount(text)
  assert.equal(result.ok, true, text + ' should parse, got ' + JSON.stringify(result))
  assert.equal(result.minor, minor, text + ' minor')
  return result
}

/** Assert a refusal with one of the documented codes. */
function bad(text, code) {
  const result = parseAmount(text)
  assert.equal(result.ok, false, text + ' should be refused')
  assert.equal(result.code, code, text + ' code')
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message.length > 0)
  return result
}

test('plain decimals become cents, symbols and units stripped', () => {
  ok('32', 3200)
  ok('32.5', 3250)
  ok('¥32', 3200)
  ok('￥32.5', 3250)
  ok('32元', 3200)
  ok('32块', 3200)
  ok('15块', 1500)
})

test('thousand separators are allowed', () => {
  ok('￥1,280.00', 128000)
  ok('1,280.00', 128000)
  ok('1,280', 128000)
})

test('Chinese numerals convert', () => {
  ok('三十二块', 3200)
  ok('三十二', 3200)
  ok('两百', 20000)
  ok('一百零八', 10800)
  ok('十五', 1500)
  ok('八千', 800000)
  ok('一万', 1000000)
})

test('spoken Chinese shorthand means unit over ten', () => {
  ok('一万二', 1200000) // 12000 元
  ok('三千五', 350000) // 3500 元
  ok('两百五', 25000) // 250 元
  ok('一百二', 12000) // 120 元
})

test('k / w / 万 / 亿 multipliers apply in yuan', () => {
  ok('1.2k', 120000)
  ok('1.5w', 1500000)
  ok('1万2', 1200000) // 12000 元, not 1.2 万
  ok('1万2千', 1200000)
  ok('1.2万', 1200000)
  ok('3万', 3000000)
})

test('块 + 角 shorthand reads as a decimal, not two numbers', () => {
  ok('32块5', 3250)
  ok('三十二块五毛', 3250)
  ok('一块五', 150)
  ok('十五块五', 1550)
})

test('more than two decimals are truncated, not rounded', () => {
  const result = ok('32.567', 3256)
  assert.equal(result.truncated, true)
  const exact = ok('32.56', 3256)
  assert.notEqual(exact.truncated, true)
})

test('approximate amounts are refused, never guessed', () => {
  bad('大概三十几', 'E_AMOUNT_AMBIGUOUS')
  bad('差不多50', 'E_AMOUNT_AMBIGUOUS')
  bad('三十几块', 'E_AMOUNT_AMBIGUOUS')
  bad('50左右', 'E_AMOUNT_AMBIGUOUS')
})

test('empty input is a missing amount', () => {
  bad('', 'E_AMOUNT_MISSING')
  bad('   ', 'E_AMOUNT_MISSING')
  bad(null, 'E_AMOUNT_MISSING')
  bad(undefined, 'E_AMOUNT_MISSING')
})

test('zero and negative amounts are invalid', () => {
  bad('0', 'E_AMOUNT_INVALID')
  bad('0.00', 'E_AMOUNT_INVALID')
  bad('-5', 'E_AMOUNT_INVALID')
  bad('¥-5', 'E_AMOUNT_INVALID')
})

test('the 1e9 分 ceiling is inclusive', () => {
  ok('10000000', 1000000000) // exactly 1000 万元
  bad('20000000', 'E_AMOUNT_INVALID')
  bad('2亿', 'E_AMOUNT_INVALID')
  bad('两亿', 'E_AMOUNT_INVALID')
})

test('garbage is invalid rather than zero', () => {
  bad('随便说个数', 'E_AMOUNT_INVALID')
  bad('abc', 'E_AMOUNT_INVALID')
})

test('raw is echoed verbatim (untrimmed input is trimmed)', () => {
  assert.equal(parseAmount(' ¥32 ').raw, '¥32')
  assert.equal(parseAmount('三十二块').raw, '三十二块')
})

test('full-width digits from a phone keyboard still parse', () => {
  ok('３２', 3200)
})

test('numbers are accepted as a convenience', () => {
  ok(32, 3200)
  ok(32.5, 3250)
})
