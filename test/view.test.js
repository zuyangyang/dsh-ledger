import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_OWNER, ownerOf } from '../lib/ownership.js'
import { createView } from '../lib/view.js'

function runtime({ records = [], owners = new Map(), auth = null } = {}) {
  return {
    store: { all: () => records },
    owners,
    auth,
    config: {},
    logger: { warn() {} },
  }
}

/** A stand-in for dsh-family-auth with one member (u_a) and one stranger (u_b). */
function authWith(scope, overrides = {}) {
  return {
    readScope: () => scope,
    mustWrite: () => ({ ownerId: 'u_a', anonymous: false }),
    ownerLabel: (id) => (id === 'u_a' ? '杨' : id === DEFAULT_OWNER ? '未识别' : id),
    actorOf: () => ({ id: 'u_a', name: '杨', role: 'member' }),
    ...overrides,
  }
}

const mine = { id: 'r1', ownerId: 'u_a', amount_minor: 100 }
const theirs = { id: 'r2', ownerId: 'u_b', amount_minor: 200 }
const shared = { id: 'r3', amount_minor: 300 }

test('without dsh-family-auth a view is unrestricted', () => {
  const view = createView(runtime({ records: [mine, theirs] }), {})
  assert.equal(view.authActive, false)
  assert.equal(view.all().length, 2)
  assert.equal(view.byId('r2').id, 'r2')
})

test('without dsh-family-auth new records land in the shared bucket', () => {
  const view = createView(runtime(), undefined)
  assert.deepEqual(view.stamp(), { ownerId: DEFAULT_OWNER, ownerName: '未识别', anonymous: true })
})

test('a scope of one owner hides everyone else', () => {
  const view = createView(runtime({ records: [mine, theirs], auth: authWith(new Set(['u_a'])) }), {})
  assert.deepEqual(view.all().map((record) => record.id), ['r1'])
})

test('an out-of-scope record is not found by id', () => {
  const view = createView(runtime({ records: [mine, theirs], auth: authWith(new Set(['u_a'])) }), {})
  assert.equal(view.byId('r2'), null)
  assert.equal(view.byId('r1').id, 'r1')
})

test('an unrestricted owner scope returns everything', () => {
  const view = createView(runtime({ records: [mine, theirs], auth: authWith(null) }), {})
  assert.equal(view.all().length, 2)
})

test('the shared bucket is visible when the scope names it', () => {
  const view = createView(runtime({ records: [mine, shared], auth: authWith(new Set(['u_a', DEFAULT_OWNER])) }), {})
  assert.deepEqual(view.all().map((record) => record.id), ['r1', 'r3'])
})

test('a record with no inline owner falls back to the side table', () => {
  const owners = new Map([['r3', 'u_b']])
  const view = createView(runtime({ records: [shared], owners, auth: authWith(new Set(['u_b'])) }), {})
  assert.deepEqual(view.all().map((record) => record.id), ['r3'])
})

test('a record nobody claimed belongs to the shared bucket', () => {
  const view = createView(runtime({ records: [shared], auth: authWith(new Set([DEFAULT_OWNER])) }), {})
  assert.deepEqual(view.all().map((record) => record.id), ['r3'])
  const hidden = createView(runtime({ records: [shared], auth: authWith(new Set(['u_a'])) }), {})
  assert.equal(hidden.all().length, 0)
})

test('identity=auth without the service refuses instead of showing everything', () => {
  const bare = { ...runtime({ records: [mine, theirs] }), config: { identity: 'auth' } }
  assert.throws(() => createView(bare, {}).all(), /家庭权限未就绪/)
})

test('identity=auth with the service is scoped as usual', () => {
  const scoped = { ...runtime({ records: [mine, theirs], auth: authWith(new Set(['u_a'])) }), config: { identity: 'auth' } }
  assert.deepEqual(createView(scoped, {}).all().map((record) => record.id), ['r1'])
})

test('a guard that cannot answer yields an empty view, never everything', () => {
  const auth = authWith(null, {
    readScope() { throw new Error('no session') },
  })
  const view = createView(runtime({ records: [mine, theirs], auth }), {})
  assert.deepEqual(view.all(), [])
})

test('the stamp comes from the guard when auth is active', () => {
  const view = createView(runtime({ auth: authWith(null) }), {})
  assert.deepEqual(view.stamp(), { ownerId: 'u_a', ownerName: '杨', anonymous: false })
})

test('the actor name is available for receipts', () => {
  const view = createView(runtime({ auth: authWith(null) }), {})
  assert.equal(view.actorName(), '杨')
  assert.equal(view.isOwner(), false)
})

test('an explicit claim overrides the owner guessed at write time', () => {
  const owners = new Map([['r1', 'u_b']])
  // A record an unknown session wrote carries ownerId 'default'; claiming it
  // later must actually move it, otherwise the shared bucket is a trap.
  assert.equal(ownerOf({ id: 'r1', ownerId: 'default' }, owners), 'u_b')
  assert.equal(ownerOf({ id: 'r1', ownerId: 'u_a' }, owners), 'u_b')
  assert.equal(ownerOf({ id: 'r1' }, owners), 'u_b')
  assert.equal(ownerOf({ id: 'r1', ownerId: 'u_a' }, new Map()), 'u_a')
  assert.equal(ownerOf({ id: 'r9' }, owners), DEFAULT_OWNER)
})
