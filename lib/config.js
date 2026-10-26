/**
 * Config normalization. Config is deployment-owned; runtime toggles live in
 * meta.json (DESIGN.md 14). Only this module decides the effective values.
 * @module dsh-ledger/config
 */

import { expandHome } from './util.js'

/** Where the journal lives unless the deployment says otherwise. */
export const DEFAULT_DATA_DIR = '~/.dsh/ledger'

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
  const nightlyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.nightlyTime || '') ? raw.nightlyTime : '21:30'
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
    defaultActor: raw.defaultActor || 'yang',
    actorBookRouting: raw.actorBookRouting !== false,
    purchaseSettlementDefault: raw.purchaseSettlementDefault === 'credit' ? 'credit' : 'cash',
    brief: raw.brief !== false,
    briefMaxChars: clampInt(raw.briefMaxChars, 120, 800, 240),
    skill: raw.skill !== false,
    nightlyEnabled: raw.nightlyEnabled !== false,
    nightlyTime,
    nightlyShopDaily: raw.nightlyShopDaily !== false,
    nightlyHomeWeekly: clampInt(raw.nightlyHomeWeekly, 0, 7, 1),
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