/**
 * Config normalization. Config is deployment-owned; runtime toggles live in
 * meta.json (DESIGN.md 14). Only this module decides the effective values.
 * @module dsh-ledger/config
 */

import { expandHome } from './util.js'

/** Where the journal lives unless the deployment says otherwise. */
export const DEFAULT_DATA_DIR = '~/.dsh/ledger'

/** dsh-im's WeChat account settings, where the owner names each account. */
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
  const dataDir = expandHome(configuredDir.trim().length > 0 ? configuredDir : DEFAULT_DATA_DIR)
  const defaultDataDir = expandHome(DEFAULT_DATA_DIR)
  return {
    enabled: raw.enabled !== false,
    dataDir,
    defaultDataDir,
    dataDirIsDefault: dataDir === defaultDataDir,
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
        : DEFAULT_IM_ACCOUNTS_PATH),
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