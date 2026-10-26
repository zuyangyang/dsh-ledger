import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeActor, parseImSource, resolveActor } from '../lib/actors.js'

const config = { defaultActor: 'yang' }

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

test('without any source the configured default names the entry', () => {
  const resolved = resolveActor({ sourceText: '午饭32', config })
  assert.equal(resolved.actor, 'yang')
  assert.equal(resolved.actorSource, 'default')
  assert.equal(resolved.actorField, null)
  assert.equal(resolveActor({ sourceText: '午饭32', config: {} }).actor, 'unknown')
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
