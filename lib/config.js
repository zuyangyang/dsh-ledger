/**
 * Config normalization. Config is deployment-owned; runtime toggles live in
 * meta.json (DESIGN.md 14). Only this module decides the effective values.
 * @module dsh-ledger/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { expandHome } from './util.js'

/**
 * The default journal, inside the harness home rather than at a fixed path.
 *
 * $DSH_HOME is what keeps two DSH profiles apart: the desktop app points it at
 * ~/.dsh, a second profile points it somewhere else, and neither has to
 * remember to configure a dataDir to stay out of the other's records. A fixed
 * default would quietly put two households' books in the same file.
 * @param {object} [env] - environment to read.
 * @returns {string} absolute directory.
 */
export function defaultDataDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'ledger')
}

/** How the default reads in config descriptions. */
export const DEFAULT_DATA_DIR_LABEL = '<DSH_HOME>/ledger（DSH_HOME 未设置时是 ~/.dsh/ledger）'

/**
 * dsh-im's WeChat account settings, where the owner names each account.
 *
 * Inside $DSH_HOME for the same reason as the journal: each profile has its own
 * dsh-im install and its own account ids. Reading the desktop file from a second
 * profile finds a table of account ids that profile never connected, so every
 * message resolves to "unknown" while the ids look valid.
 * @param {object} [env] - environment to read.
 * @returns {string} absolute path.
 */
export function defaultImAccountsPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'integrations', 'dsh-weixin', 'workspaces.json')
}

/** Kept for callers that only want the desktop path. */
export const DEFAULT_IM_ACCOUNTS_PATH = '~/.dsh/integrations/dsh-weixin/workspaces.json'

export const HOME_CATEGORIES = [
  'food', 'transport', 'housing', 'shopping', 'health', 'entertainment',
  'education', 'communication', 'social', 'travel', 'pet', 'other',
]

export const HOME_INCOME_CATEGORIES = [
  'salary', 'bonus', 'investment', 'reimburse', 'gift', 'other_income',
]

export const BIZ_CATEGORIES = [
  'biz_revenue', 'biz_other_income', 'biz_rent', 'biz_utilities', 'biz_packaging',
  'biz_shipping', 'biz_labor', 'biz_repair', 'biz_marketing', 'biz_entertain',
  'biz_transport', 'biz_fee', 'biz_loss', 'biz_other', 'biz_cashflow',
]

/**
 * Everything the rest of the plugin reads. Never mutate; rebuild on config
 * change (Cordis calls apply again).
 */
export function normalizeConfig(raw = {}) {
  // Only a string counts as a directory; null/numbers fall back to the default
  // rather than silently resolving to the home directory itself.
  const configuredDir = typeof raw.dataDir === 'string' ? raw.dataDir : ''
  const fallbackDir = defaultDataDir()
  const dataDir = expandHome(configuredDir.trim().length > 0 ? configuredDir : fallbackDir)
  const defaultDir = fallbackDir
  return {
    enabled: raw.enabled !== false,
    dataDir,
    defaultDataDir: defaultDir,
    dataDirIsDefault: dataDir === defaultDir,
    timezone: 'Asia/Shanghai',
    dayCutoffHour: clampInt(raw.dayCutoffHour, 0, 12, 4),
    defaultBook: raw.defaultBook === 'shop' ? 'shop' : 'home',
    shopBook: 'shop',
    homeName: '家里',
    shopName: raw.shopName || '店里',
    imAccounts: {
      enabled: raw.imAccounts?.enabled !== false,
      path: expandHome(typeof raw.imAccounts?.path === 'string' && raw.imAccounts.path.trim().length > 0
        ? raw.imAccounts.path.trim()
        : defaultImAccountsPath()),
    },
    actorBookRouting: raw.actorBookRouting !== false,
    purchaseSettlementDefault: raw.purchaseSettlementDefault === 'credit' ? 'credit' : 'cash',
    brief: raw.brief !== false,
    briefMaxChars: clampInt(raw.briefMaxChars, 120, 800, 240),
    skill: raw.skill !== false,
    autoCommit: raw.autoCommit !== false,
    commitDebounceSec: clampInt(raw.commitDebounceSec, 5, 600, 60),
    obsidian: {
      enabled: raw.obsidian?.enabled !== false,
      daily: raw.obsidian?.daily !== false,
      monthly: raw.obsidian?.monthly !== false,
    },
    redact: raw.redact !== false,
    diag: raw.diag === true,
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}