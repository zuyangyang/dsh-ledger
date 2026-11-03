/**
 * The two HTTP routes the settings panel talks to: one read-only month payload
 * for the dashboard, one read/write endpoint for the settings themselves.
 *
 * They are plain `webServer.register` routes rather than the settings wire,
 * because the settings wire only serves a host-owned allowlist and can never
 * write a third-party plugin's config.
 * @module dsh-ledger/web
 */

import { buildDashboard, resolveMonth } from './dashboard.js'
import { RANGE_GROUPS, RANGE_BOOKS, actorNamesOf, buildRangeDashboard } from './range.js'
import { describeSettings, readUiConfig, saveUiConfig, uiConfigPath } from './uiconfig.js'

export const DASHBOARD_ROUTE = '/api/ledger/summary'
export const RANGE_ROUTE = '/api/ledger/range'
export const ACTORS_ROUTE = '/api/ledger/actors'
export const CONFIG_ROUTE = '/api/ledger/config'

/** Register both routes; returns nothing, disposal is owned by `ctx.effect`. */
export function registerWebRoutes(ctx, runtime, { baseConfig = {}, uiPath = uiConfigPath() } = {}) {
  const disposers = []

  // The dashboard is a browser page: it carries no DSH session, so there is no
  // member to scope it to. Rather than serve one person's rows to whoever opens
  // the URL, the whole panel closes when dsh-family-auth is driving identity.
  const respond = (res, run) => {
    if (runtime.auth) {
      return sendJson(res, () => ({
        status: 403,
        body: {
          error: 'panel_closed',
          message: '启用家庭权限后账本面板关闭：面板没有会话身份，判断不了该给你看哪些记录。'
            + '请在对话里用 ledger_report / ledger_debt 查看。',
        },
      }))
    }
    return sendJson(res, run)
  }

  const configPayload = () => {
    const saved = readUiConfig(uiPath)
    return {
      settings: describeSettings({ base: baseConfig, overrides: saved.values }),
      ui_config_path: saved.path,
      overrides: saved.values,
      restart_required: false,
    }
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: DASHBOARD_ROUTE,
    handler: (req, res) => respond(res, () => {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
      const month = resolveMonth(new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('month') ?? undefined)
      return {
        status: 200,
        body: buildDashboard({
          records: runtime.store.all(),
          config: runtime.config,
          stats: runtime.store.stats(),
          git: runtime.git,
          month,
        }),
      }
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: RANGE_ROUTE,
    handler: (req, res) => respond(res, () => {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
      const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const group = params.get('group') ?? 'book'
      if (!RANGE_GROUPS.includes(group)) {
        return { status: 400, body: { error: 'group 只能是 ' + RANGE_GROUPS.join(' / ') } }
      }
      const book = params.get('book') ?? 'all'
      if (!RANGE_BOOKS.includes(book)) {
        return { status: 400, body: { error: 'book 只能是 ' + RANGE_BOOKS.join(' / ') } }
      }
      const payload = buildRangeDashboard({
        records: runtime.store.all(),
        config: runtime.config,
        stats: runtime.store.stats(),
        git: runtime.git,
        from: params.get('from') ?? undefined,
        to: params.get('to') ?? undefined,
        group,
        book,
        actorNames: actorNamesOf(runtime.store.meta),
      })
      if (payload.error) return { status: 400, body: { error: payload.error } }
      return { status: 200, body: payload }
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: ACTORS_ROUTE,
    handler: (req, res) => respond(res, async () => {
      if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
      const parsed = await readJson(req)
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
      const body = parsed.value ?? {}
      const key = typeof body.key === 'string' ? body.key.trim() : ''
      if (key.length === 0 || key.length > 200) return { status: 400, body: { error: 'key 必须是一个非空的名字' } }
      const rawName = body.name === undefined || body.name === null ? '' : String(body.name)
      const name = rawName.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24)
      const saved = { ...(runtime.store.meta?.actorNames || {}) }
      if (name.length === 0) delete saved[key]
      else saved[key] = name
      // 只动这一个键：别名是显示用的小事实，不该重写整个 meta。
      runtime.store.patchMeta({ actorNames: saved })
      return { status: 200, body: { actorNames: saved, changed: true } }
    }),
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_ROUTE,
    handler: (req, res) => respond(res, async () => {
      if (req.method === 'GET') return { status: 200, body: configPayload() }
      if (req.method === 'POST') {
        const parsed = await readJson(req)
        if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
        const saved = saveUiConfig(parsed.value?.values ?? parsed.value, uiPath)
        if (!saved.ok) return { status: 400, body: { error: saved.error } }
        return {
          status: 200,
          body: { ...configPayload(), changed: saved.changed, restart_required: saved.changed.length > 0 },
        }
      }
      return { status: 405, body: { error: 'method not allowed' } }
    }),
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A route that is already gone is not an error worth failing shutdown.
      }
    }
  }
}

/** Wrap a handler: JSON out, errors as 500 with a readable message. */
async function sendJson(res, run) {
  try {
    const { status, body } = await run()
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
}

/** Read a JSON request body, bounded so a stray request cannot exhaust memory. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return { ok: false, error: 'request body too large' }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: 'body must be JSON' }
  }
}