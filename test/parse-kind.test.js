import assert from 'node:assert/strict'
import test from 'node:test'

import { KINDS } from '../lib/events.js'
import { detectPaymentMethod, detectSettlement, inferKind } from '../lib/parse/kind.js'

function kind(text, book) {
  const result = inferKind(text, book ? { book } : {})
  assert.ok(KINDS.includes(result.kind), result.kind + ' must be a KINDS member')
  assert.equal(typeof result.confidence, 'number')
  assert.ok(result.confidence > 0 && result.confidence <= 1, 'confidence in (0,1]')
  assert.equal(typeof result.reason, 'string')
  assert.ok(result.reason.length > 0)
  return result
}

test('shop sale clues win for 卖 / 零售 / 批发 / 出货', () => {
  assert.equal(kind('卖了480', 'shop').kind, 'sale')
  assert.equal(kind('零售3双', 'shop').kind, 'sale')
  assert.equal(kind('批发给老陈', 'shop').kind, 'sale')
  assert.equal(kind('拿货10双', 'shop').kind, 'sale')
  assert.equal(kind('出货5件', 'shop').kind, 'sale')
  assert.equal(kind('今天收了多少', 'shop').kind, 'sale')
})

test('goods leaving by hand still reads as a sale', () => {
  assert.equal(kind('老李拿了两双', 'shop').kind, 'sale')
})

test('purchase clues', () => {
  assert.equal(kind('进货2000', 'shop').kind, 'purchase')
  assert.equal(kind('上了3000的货', 'shop').kind, 'purchase')
  assert.equal(kind('厂家发了5000', 'shop').kind, 'purchase')
  assert.equal(kind('老王那儿的货款', 'shop').kind, 'purchase')
})

test('money coming in from a customer is payment_in, never income', () => {
  assert.equal(kind('客户还了2000', 'shop').kind, 'payment_in')
  assert.equal(kind('老李给了500', 'shop').kind, 'payment_in')
  assert.equal(kind('打过来了1000', 'shop').kind, 'payment_in')
})

test('money going out to a supplier is payment_out', () => {
  assert.equal(kind('我付了厂家3000', 'shop').kind, 'payment_out')
  assert.equal(kind('结账了', 'shop').kind, 'payment_out')
})

test('returns, stocktakes and owner draws', () => {
  assert.equal(kind('客户退了300', 'shop').kind, 'return')
  assert.equal(kind('说不合适退回来', 'shop').kind, 'return')
  assert.equal(kind('盘点一下', 'shop').kind, 'stocktake')
  assert.equal(kind('数了一下还剩12双', 'shop').kind, 'stocktake')
  assert.equal(kind('从店里拿了两双回家', 'shop').kind, 'draw')
  assert.equal(kind('自己穿了一双', 'shop').kind, 'draw')
})

test('shop clues do not leak into the home book', () => {
  // "退了" is a home refund, not a shop return.
  assert.equal(kind('退了50', 'home').kind, 'refund')
  assert.equal(kind('退款200', 'home').kind, 'refund')
})

test('home income and transfer clues', () => {
  assert.equal(kind('工资到账12000', 'home').kind, 'income')
  assert.equal(kind('报销到账320', 'home').kind, 'income')
  assert.equal(kind('转到余额宝1000', 'home').kind, 'transfer')
  assert.equal(kind('还信用卡3000', 'home').kind, 'transfer')
  assert.equal(kind('信用卡到账2000', 'home').kind, 'transfer') // 5.4 exception
})

test('no clue means a low-confidence expense, never a guess', () => {
  const home = kind('买菜60')
  assert.equal(home.kind, 'expense')
  assert.ok(home.confidence < 0.8)
  assert.equal(kind('买了个灯60', 'shop').kind, 'expense')
  assert.equal(kind('今天天气不错').kind, 'expense')
})

test('the strongest clue wins in a short sentence', () => {
  // 卖了 is the point of the sentence; 现金 only says how it was paid.
  assert.equal(kind('卖了480，现金', 'shop').kind, 'sale')
  // 盘点 outranks the casual 数了.
  assert.equal(kind('盘点一下，数了一下12双', 'shop').kind, 'stocktake')
})

test('detectSettlement reads credit before cash', () => {
  assert.equal(detectSettlement('先欠着'), 'credit')
  assert.equal(detectSettlement('月底结'), 'credit')
  assert.equal(detectSettlement('过几天给'), 'credit')
  assert.equal(detectSettlement('赊两双'), 'credit')
  assert.equal(detectSettlement('欠'), 'credit')
  assert.equal(detectSettlement('给了200，剩下的欠着'), 'credit')
})

test('detectSettlement reads cash only when the user said so', () => {
  assert.equal(detectSettlement('现金'), 'cash')
  assert.equal(detectSettlement('扫码付的'), 'cash')
  assert.equal(detectSettlement('付清了'), 'cash')
})

test('detectSettlement is null when settlement was never mentioned', () => {
  assert.equal(detectSettlement('今天天气不错'), null)
  assert.equal(detectSettlement('老陈拿了两双'), null)
  assert.equal(detectSettlement(''), null)
})

test('detectPaymentMethod maps the four instruments', () => {
  assert.equal(detectPaymentMethod('微信'), 'wechat')
  assert.equal(detectPaymentMethod('用微信付的'), 'wechat')
  assert.equal(detectPaymentMethod('支付宝'), 'alipay')
  assert.equal(detectPaymentMethod('花呗'), 'alipay')
  assert.equal(detectPaymentMethod('现金'), 'cash')
  assert.equal(detectPaymentMethod('刷卡'), 'card')
  assert.equal(detectPaymentMethod('信用卡'), 'card')
})

test('detectPaymentMethod never invents an instrument', () => {
  assert.equal(detectPaymentMethod('不知道'), null)
  assert.equal(detectPaymentMethod(''), null)
})
