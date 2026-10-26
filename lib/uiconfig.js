/**
 * Settings the user changes in the panel, saved next to the DSH home rather than
 * in the profile patch: the panel must survive a deployment-owned YAML file it
 * cannot safely rewrite. Panel values win over the patch, and every value is
 * validated here so a bad one cannot strand the plugin on the next start.
 *
 * The file is read once per activation, which is why every save says "restart".
 * @module dsh-ledger/uiconfig
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { expandHome } from './util.js'

export const UI_CONFIG_VERSION = 1

/** `<dshHome>/ledger-ui.json` — stable even when dataDir moves. */
export function uiConfigPath(dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')) {
  return join(dshHome, 'ledger-ui.json')
}

/**
 * Every setting the panel may edit. `source` naming mirrors the Config keys so
 * mergeConfig is a rename-free copy.
 */
export const SETTINGS = [
  {
    key: 'dataDir',
    type: 'string',
    label: '账本目录',
    hint: '换目录 = 换一本新账。改完重启 DSH 生效；旧数据用 ledger_doctor 里的 cp 命令搬。',
  },
  { key: 'shopName', type: 'string', label: '店里叫什么', hint: '回执里的方括号标签。' },
  { key: 'defaultActor', type: 'string', label: '默认录入人', hint: '认不出是谁记的时候算谁的。' },
  { key: 'defaultBook', type: 'choice', options: ['home', 'shop'], label: '默认账本' },
  { key: 'purchaseSettlementDefault', type: 'choice', options: ['cash', 'credit'], label: '进货默认结算', hint: 'cash=没说就记付清，credit=没说就记欠着。' },
  { key: 'nightlyEnabled', type: 'boolean', label: '夜间小结' },
  { key: 'nightlyTime', type: 'time', label: '小结时间', hint: '24 小时制 HH:MM。' },
  { key: 'nightlyHomeWeekly', type: 'integer', min: 0, max: 7, label: '家里小结星期', hint: '1=周一，0=不做。' },
  { key: 'dayCutoffHour', type: 'integer', min: 0, max: 12, label: '日界小时', hint: '凌晨几点算新的一天，默认 4。' },
  { key: 'autoCommit', type: 'boolean', label: '自动 git 提交' },
  { key: 'commitDebounceSec', type: 'integer', min: 5, max: 600, label: '提交防抖秒数' },
  { key: 'brief', type: 'boolean', label: '对话开头摘要' },
]

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]))

/** Validate one value; returns `{ok, value}` or `{ok:false, error}`. */
export function coerceSetting(key, value) {
  const setting = BY_KEY.get(key)
  if (!setting) return { ok: false, error: '不允许修改的配置项：' + key }
  if (setting.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: key + ' 只要 true/false' }
    return { ok: true, value }
  }
  if (setting.type === 'integer') {
    const number = Number(value)
    if (!Number.isFinite(number) || !Number.isInteger(number)) return { ok: false, error: key + ' 要整数' }
    if (number < setting.min || number > setting.max) {
      return { ok: false, error: key + ' 要在 ' + setting.min + '–' + setting.max + ' 之间' }
    }
    return { ok: true, value: number }
  }
  if (setting.type === 'choice') {
    const text = String(value ?? '').trim()
    if (!setting.options.includes(text)) return { ok: false, error: key + ' 只能是 ' + setting.options.join(' / ') }
    return { ok: true, value: text }
  }
  if (setting.type === 'time') {
    const text = String(value ?? '').trim()
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return { ok: false, error: key + ' 要 HH:MM（00:00–23:59）' }
    return { ok: true, value: text }
  }
  const text = String(value ?? '').trim()
  if (text.length > 500) return { ok: false, error: key + ' 太长了' }
  return { ok: true, value: text }
}

/** Read saved overrides; a broken file is an empty set, never a crash. */
export function readUiConfig(path = uiConfigPath()) {
  if (!existsSync(path)) return { path, values: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const values = {}
    for (const [key, value] of Object.entries(parsed?.values ?? {})) {
      const coerced = coerceSetting(key, value)
      if (coerced.ok) values[key] = coerced.value
    }
    return { path, values }
  } catch {
    return { path, values: {}, broken: true }
  }
}

/** Merge saved overrides into the deployment config (panel wins). */
export function mergeConfig(base = {}, overrides = {}) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (BY_KEY.has(key)) merged[key] = value
  }
  return merged
}

/**
 * Write a patch of overrides atomically. Returns the full saved set.
 * @param {{values: object}} input
 */
export function saveUiConfig(patch, path = uiConfigPath()) {
  const current = readUiConfig(path)
  const next = { ...current.values }
  const changed = []
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null || value === undefined || value === '') {
      if (key in next) {
        delete next[key]
        changed.push(key)
      }
      continue
    }
    const coerced = coerceSetting(key, value)
    if (!coerced.ok) return { ok: false, error: coerced.error }
    if (next[key] !== coerced.value) changed.push(key)
    next[key] = coerced.value
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify({ version: UI_CONFIG_VERSION, values: next }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
  return { ok: true, values: next, changed, path }
}

/**
 * What the panel renders: every editable setting, its effective value, and
 * whether that value comes from the panel file or the deployment patch.
 */
export function describeSettings({ base = {}, overrides = {} } = {}) {
  return SETTINGS.map((setting) => {
    const effective = setting.key in overrides
      ? overrides[setting.key]
      : (base[setting.key] !== undefined ? base[setting.key] : null)
    return {
      key: setting.key,
      label: setting.label,
      type: setting.type,
      options: setting.options ?? null,
      min: setting.min ?? null,
      max: setting.max ?? null,
      hint: setting.hint ?? null,
      value: effective,
      source: setting.key in overrides ? 'ui' : (base[setting.key] !== undefined ? 'deployment' : 'default'),
    }
  })
}
