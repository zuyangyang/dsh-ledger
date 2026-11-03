import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ledger-it-home-'))

/**
 * End-to-end through the real plugin entry point and the real tools.
 *
 * The unit tests prove the view filters correctly; this proves the wiring that
 * the family actually depends on: two conversations, two members, no leakage.
 * The auth service is a stand-in with the same contract as dsh-family-auth, so
 * the test exercises what the ledger does with that contract rather than
 * re-testing the guard itself.
 */
const MEMBERS = {
  session_yang: { id: 'u_yang', name: '杨', role: 'owner' },
  session_hong: { id: 'u_hong', name: '小红', role: 'member' },
}

function fakeAuth() {
  const member = (exec) => MEMBERS[exec?.agent?.session?.id] || null
  return {
    actorOf: (exec) => member(exec),
    readScope: (exec) => {
      const who = member(exec)
      return new Set(who ? [who.id, 'default'] : ['default'])
    },
    mustWrite: (exec) => {
      const who = member(exec)
      return who
        ? { ownerId: who.id, actor: who, anonymous: false }
        : { ownerId: 'default', actor: null, anonymous: true }
    },
    ownerLabel: (ownerId) => {
      if (ownerId === 'default') return '未识别'
      const found = Object.values(MEMBERS).find((one) => one.id === ownerId)
      return found ? found.name : ownerId
    },
    findMember: (name) => Object.values(MEMBERS).find((one) => one.name === name) || null,
  }
}

function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-it-'))
  const tools = []
  const auth = fakeAuth()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    tools: { register: (tool) => tools.push(tool) },
    skills: { register: () => {} },
    systemPrompt: { context: () => {} },
    inject: (names, run) => {
      // The real guard is provided by dsh-family-auth; hand over the stand-in.
      run({ ...ctx, familyAuth: auth })
    },
    effect: () => () => {},
  }
  const { apply } = pluginRef
  const dispose = apply(ctx, { dataDir, autoCommit: false, brief: false, skill: false })
  const call = (name, args, exec) => tools.find((tool) => tool.name === name).execute(args, exec)
  return { call, tools, dispose }
}

const as = (session) => ({ agent: { session: { id: session } } })

const pluginRef = await import('../lib/index.js')

test('two members do not see each other\'s entries', async () => {
  const { call, dispose } = boot()

  const yang = await call('ledger_add', { amount: '32', note: '午饭', source_text: '午饭32' }, as('session_yang'))
  assert.equal(yang.entered_by, '杨')
  await call('ledger_add', { amount: '20', note: '买菜', source_text: '买菜20' }, as('session_hong'))

  const seenByYang = await call('ledger_query', { month: '2026-11', include_void: true }, as('session_yang'))
  assert.match(seenByYang.text, /午饭/)
  assert.match(seenByYang.text, /杨 记/, 'the receipt names the member who wrote it')
  assert.equal(seenByYang.text.includes('买菜'), false, '杨 must not see 小红 entries')

  const seenByHong = await call('ledger_query', { month: '2026-11', include_void: true }, as('session_hong'))
  assert.match(seenByHong.text, /买菜/)
  assert.equal(seenByHong.text.includes('午饭'), false, '小红 must not see 杨 entries')

  dispose()
})

test('an unidentified conversation writes to the shared bucket and both can see it', async () => {
  const { call, dispose } = boot()

  const anonymous = await call('ledger_add', { amount: '15', note: '地铁', source_text: '地铁15' }, undefined)
  assert.equal(anonymous.entered_by, '未识别')

  for (const session of ['session_yang', 'session_hong']) {
    const seen = await call('ledger_query', { month: '2026-11', include_void: true }, as(session))
    assert.match(seen.text, /地铁/, session + ' should see the shared bucket')
  }

  dispose()
})

test('the owner can claim records that nobody owns', async () => {
  const { call, dispose } = boot()

  await call('ledger_add', { amount: '15', note: '地铁', source_text: '地铁15' }, undefined)

  const refused = await call('ledger_claim', { member: '杨', entered_by: '未识别' }, as('session_hong'))
    .then(() => null, (error) => error)
  assert.match(refused.message, /户主/, 'only the owner may claim')

  const claimed = await call('ledger_claim', { member: '杨', entered_by: '未识别' }, as('session_yang'))
  assert.equal(claimed.claimed, 1)

  const seenByHong = await call('ledger_query', { month: '2026-11', include_void: true }, as('session_hong'))
  assert.equal(seenByHong.text.includes('地铁'), false, 'after claiming, the shared entry is private')

  dispose()
})
