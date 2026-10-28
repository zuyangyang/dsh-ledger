/**
 * Names of the IM accounts that delivered a message (DESIGN.md 4.8).
 *
 * dsh-im connects several WeChat accounts at once and the owner gives each one a
 * name in its settings panel ("Yang", "Mei"). Those names are what the household
 * actually calls the two phones, while the sender id that dsh-im puts in the
 * `<dsh_im_source>` block identifies the *person* — the same person on both
 * phones — and is unreadable anyway. So the account name is the honest answer to
 * "who typed this" here.
 *
 * The mapping lives in dsh-im's own config: `aliases` keys are the account ids
 * dsh-im also publishes as `botId` in the source block. The file is read lazily
 * and re-read after its mtime changes, so renaming an account in dsh-im shows up
 * in the ledger without restarting DSH. A missing or broken file is not an error:
 * names are a nicety and the caller falls back to the sender id it already has.
 * @module dsh-ledger/imaccounts
 */

import { readFileSync, statSync } from 'node:fs'

import { normalizeActor } from './actors.js'

/** Where dsh-im keeps the WeChat account aliases. */
export const DEFAULT_IM_ACCOUNTS_PATH = '~/.dsh/integrations/dsh-weixin/workspaces.json'

/**
 * @param {{path?: string, enabled?: boolean, logger?: object}} input
 */
export function createImAccountNames({ path, enabled = true, logger = console } = {}) {
  let loaded = null
  let warned = false

  function readNames() {
    if (typeof path !== 'string' || path.trim().length === 0) return null
    let stats
    try {
      stats = statSync(path)
    } catch (error) {
      // No dsh-im, no WeChat, or no aliases yet: say it once at debug level and
      // carry on. Missing names must never break a recorded entry.
      if (!warned && logger?.debug) {
        warned = true
        logger.debug('[ledger] no IM account aliases at ' + path + ' (' + (error?.code || 'error') + ')')
      }
      return null
    }
    if (loaded && loaded.mtimeMs === stats.mtimeMs) return loaded.names
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const aliases = parsed && typeof parsed.aliases === 'object' && parsed.aliases ? parsed.aliases : {}
      const names = new Map()
      for (const [botId, value] of Object.entries(aliases)) {
        const name = normalizeActor(value)
        if (typeof botId === 'string' && botId.length > 0 && name) names.set(botId, name)
      }
      loaded = { mtimeMs: stats.mtimeMs, names }
      return names
    } catch (error) {
      if (logger?.warn) logger.warn('[ledger] IM account aliases at ' + path + ' are unreadable: ' + (error?.message || error))
      loaded = { mtimeMs: stats.mtimeMs, names: null }
      return null
    }
  }

  return {
    path,
    enabled,
    /** The account name dsh-im shows for this bot id, or null. */
    nameFor(botId) {
      if (!enabled) return null
      if (typeof botId !== 'string' || botId.trim().length === 0) return null
      const names = readNames()
      if (!names) return null
      return names.get(botId.trim()) || null
    },
    /** Forget the cached file, for tests and for config reloads. */
    clear() {
      loaded = null
      warned = false
    },
  }
}
