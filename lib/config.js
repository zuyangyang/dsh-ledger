/**
 * Config normalization. Config is deployment-owned; runtime toggles live in
 * meta.json (DESIGN.md 14). Only this module decides the effective values.
 * @module dsh-ledger/config
 */

import { expandHome } from './util.js'

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
  const dataDir = expandHome(raw.dataDir || '~/.dsh/ledger')
  const nightlyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.nightlyTime || '') ? raw.nightlyTime : '21:30'
  return {
    enabled: raw.enabled !== false,
    dataDir,
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
