import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { CONFIG_ROUTE, DASHBOARD_ROUTE, registerWebRoutes } from '../lib/web.js'

function fakeCtx() {
  const routes = new Map()
  return {
    routes,
    webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
  }
}

function fakeRequest({ method = 'GET', url = '/', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const response = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { response.status = status; response.headers = headers },
    end(text) { response.body = text },
  }
  return response
}

function runtimeWith(records) {
  return {
    store: { all: () => records, stats: () => ({ dataDir: '/tmp/ledger', entries: records.length, quarantined: 0, bytes: 42 }) },
    config: normalizeConfig({}),
    git: { ready: true, enabled: true, lastError: null },
  }
}

const record = {
  id: 'tx_1', schema: 2, version: 1, kind: 'expense', status: 'confirmed', book: 'home',
  amount_minor: 2690, currency: 'CNY', occurred_on: '2026-10-26', paid_minor: 2690,
  category: { l1: 'food' }, entered_by: 'yang', created_at: '2026-10-26T12:00:00+08:00', note: '午饭',
}

test('the dashboard route answers with the asked month', async () => {
  const ctx = fakeCtx()
  const dispose = registerWebRoutes(ctx, runtimeWith([record]), { baseConfig: {}, uiPath: join(mkdtempSync(join(tmpdir(), 'ledger-web-')), 'ui.json') })
  assert.equal(ctx.routes.has(DASHBOARD_ROUTE), true)
  assert.equal(ctx.routes.has(CONFIG_ROUTE), true)
  const response = fakeResponse()
  await ctx.routes.get(DASHBOARD_ROUTE)(fakeRequest({ url: '/api/ledger/summary?month=2026-09' }), response)
  assert.equal(response.status, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  const payload = JSON.parse(response.body)
  assert.equal(payload.month, '2026-09')
  assert.equal(payload.home.expense_minor, 0)
  assert.equal(payload.storage.entries, 1)
  dispose()
  assert.equal(ctx.routes.size, 0, 'dispose removes both routes')
})

test('the config route reads, saves and refuses', async () => {
  const ctx = fakeCtx()
  const uiPath = join(mkdtempSync(join(tmpdir(), 'ledger-web-')), 'ui.json')
  registerWebRoutes(ctx, runtimeWith([record]), { baseConfig: { shopName: '店里' }, uiPath })
  const route = ctx.routes.get(CONFIG_ROUTE)

  const read = fakeResponse()
  await route(fakeRequest(), read)
  const before = JSON.parse(read.body)
  assert.equal(before.ui_config_path, uiPath)
  assert.equal(before.settings.find((setting) => setting.key === 'shopName').source, 'deployment')

  const saved = fakeResponse()
  await route(fakeRequest({ method: 'POST', body: { values: { shopName: '皮鞋店' } } }), saved)
  const after = JSON.parse(saved.body)
  assert.equal(after.restart_required, true)
  assert.equal(after.settings.find((setting) => setting.key === 'shopName').value, '皮鞋店')
  assert.equal(after.settings.find((setting) => setting.key === 'shopName').source, 'ui')
  assert.equal(JSON.parse(readFileSync(uiPath, 'utf8')).values.shopName, '皮鞋店')

  const refused = fakeResponse()
  await route(fakeRequest({ method: 'POST', body: { values: { nightlyTime: '99:99' } } }), refused)
  assert.equal(refused.status, 400)
  assert.match(JSON.parse(refused.body).error, /nightlyTime/)

  const wrongMethod = fakeResponse()
  await route(fakeRequest({ method: 'PUT' }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('a broken body is a 400, not a crash', async () => {
  const ctx = fakeCtx()
  const uiPath = join(mkdtempSync(join(tmpdir(), 'ledger-web-')), 'ui.json')
  registerWebRoutes(ctx, runtimeWith([]), { baseConfig: {}, uiPath })
  const req = { method: 'POST', url: '/', async *[Symbol.asyncIterator]() { yield Buffer.from('{ nope') } }
  const response = fakeResponse()
  await ctx.routes.get(CONFIG_ROUTE)(req, response)
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).error, 'body must be JSON')
})
