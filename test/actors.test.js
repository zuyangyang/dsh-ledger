import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeActor, parseImSource, resolveActor } from '../lib/actors.js'

const config = {}

test('the sender name wins when dsh-im supplies one', () => {
  const text = '午饭32<dsh_im_source>{"channel":"weixin","senderName":"妈","senderId":"wxid_mom"}</dsh_im_source>'
  const resolved = resolveActor({ sourceText: text, config })
  assert.equal(resolved.actor, '妈')
  assert.equal(resolved.actorSource, 'im_source_name')
  assert.equal(resolved.actorField, 'name')
})

test('a missing sender name falls back to the account id', () => {
  // dsh-im omits senderName on channels and messages without a nickname.
  const text = '午饭32<dsh_im_source>{"channel":"weixin","senderId":"wxid_mom"}</dsh_im_source>'
  const resolved = resolveActor({ sourceText: text, config })
  assert.equal(resolved.actor, 'wxid_mom')
  assert.equal(resolved.actorSource, 'im_source_id')
  assert.equal(resolved.actorField, 'id')
})

test('a blank sender name is the same as a missing one', () => {
  const text = '午饭32<dsh_im_source>{"senderName":"   ","senderId":"wxid_dad"}</dsh_im_source>'
  assert.equal(resolveActor({ sourceText: text, config }).actor, 'wxid_dad')
})

test('snake_case source blocks are accepted too', () => {
  const text = '午饭32<dsh_im_source>{"sender_name":"爸","sender_id":"wxid_dad"}</dsh_im_source>'
  const resolved = resolveActor({ sourceText: text, config })
  assert.equal(resolved.actor, '爸')
  const idOnly = '午饭32<dsh_im_source>{"sender_id":"wxid_dad"}</dsh_im_source>'
  assert.equal(resolveActor({ sourceText: idOnly, config }).actor, 'wxid_dad')
})

test('an explicit argument wins, but a placeholder does not', () => {
  const text = '午饭32<dsh_im_source>{"senderId":"wxid_dad"}</dsh_im_source>'
  assert.equal(resolveActor({ enteredBy: '杨', sourceText: text, config }).actor, '杨')
  assert.equal(resolveActor({ enteredBy: '杨', sourceText: text, config }).actorSource, 'param')
  // A model that answers "unknown" must not veto the id we can see.
  assert.equal(resolveActor({ enteredBy: 'unknown', sourceText: text, config }).actor, 'wxid_dad')
  assert.equal(resolveActor({ enteredBy: '未知', sourceText: text, config }).actor, 'wxid_dad')
})

test('the receiving account name beats the sender nickname', () => {
  const text = '午饭32<dsh_im_source>{"channel":"weixin","botId":"wx_mei","senderName":"微信用户·o9cq806i","senderId":"o9cq806i@im.wechat"}</dsh_im_source>'
  const imAccountName = (botId) => (botId === 'wx_mei' ? 'Mei' : null)
  const resolved = resolveActor({ sourceText: text, config, imAccountName })
  assert.equal(resolved.actor, 'Mei')
  assert.equal(resolved.actorSource, 'im_account')
  assert.equal(resolved.actorField, 'account')
})

test('a model echoing the source block does not veto the account name', () => {
  const text = '午饭32<dsh_im_source>{"channel":"weixin","botId":"wx_mei","senderName":"微信用户·o9cq806i","senderId":"o9cq806i@im.wechat"}</dsh_im_source>'
  const imAccountName = (botId) => (botId === 'wx_mei' ? 'Mei' : null)
  // Repeating senderName / senderId is not a choice, it is a copy of the block.
  assert.equal(resolveActor({ enteredBy: '微信用户·o9cq806i', sourceText: text, config, imAccountName }).actor, 'Mei')
  assert.equal(resolveActor({ enteredBy: 'o9cq806i@im.wechat', sourceText: text, config, imAccountName }).actor, 'Mei')
})

test('a name the user actually said still wins over the account', () => {
  const text = '午饭32<dsh_im_source>{"botId":"wx_mei","senderName":"微信用户·o9cq806i"}</dsh_im_source>'
  const imAccountName = () => 'Mei'
  const resolved = resolveActor({ enteredBy: '妈妈', sourceText: text, config, imAccountName })
  assert.equal(resolved.actor, '妈妈')
  assert.equal(resolved.actorSource, 'param')
})

test('without a bot id the older order still holds', () => {
  const imAccountName = (botId) => (botId === 'wx_mei' ? 'Mei' : null)
  const text = '午饭32<dsh_im_source>{"senderName":"妈","senderId":"wxid_mom"}</dsh_im_source>'
  assert.equal(resolveActor({ sourceText: text, config, imAccountName }).actor, '妈')
  const unknownBot = '午饭32<dsh_im_source>{"botId":"wx_nobody","senderName":"妈"}</dsh_im_source>'
  assert.equal(resolveActor({ sourceText: unknownBot, config, imAccountName }).actor, '妈')
})

test('without any source the entry is marked unidentified', () => {
  const resolved = resolveActor({ sourceText: '午饭32', config })
  assert.equal(resolved.actor, '未识别')
  assert.equal(resolved.actorSource, 'unidentified')
  assert.equal(resolved.actorField, null)
  assert.equal(resolveActor({ sourceText: '午饭32', config: {} }).actor, '未识别')
})

test('normalizeActor strips padding, control and zero-width characters', () => {
  assert.equal(normalizeActor('  妈\u200b '), '妈')
  assert.equal(normalizeActor('杨  洋'), '杨 洋')
  assert.equal(normalizeActor(''), null)
  assert.equal(normalizeActor('   '), null)
  assert.equal(normalizeActor(null), null)
  assert.equal(normalizeActor(42), '42')
})

test('parseImSource tolerates a broken block', () => {
  assert.equal(parseImSource('no block here'), null)
  assert.equal(parseImSource('<dsh_im_source>{not json}</dsh_im_source>'), null)
  const parsed = parseImSource('<dsh_im_source>{"senderId":12345}</dsh_im_source>')
  assert.equal(parsed.senderId, '12345')
  assert.equal(parsed.senderName, null)
})
