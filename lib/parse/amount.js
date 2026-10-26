/**
 * Amount parsing: the user's words in, integer minor units out (DESIGN.md 5.2).
 *
 * Everything here is deterministic and pure: no clock, no I/O, no dependencies.
 * Callers always get an object, never a throw:
 *
 *   { ok: true, minor: 3200, raw: '32' }            // 32.00 元
 *   { ok: false, code: 'E_AMOUNT_AMBIGUOUS', message: '...' }
 *
 * Amounts are integer 分 end to end. Yuan is only a parse-time fiction: the
 * decimal string is truncated (never rounded) to two places, exactly as the
 * design requires, and extra digits set `truncated: true` so the receipt can
 * mention it.
 * @module dsh-ledger/parse/amount
 */

/** Hard ceiling in minor units (DESIGN 5.2): 1e9 分 = 1000 万元. */
const MINOR_CAP = 1_000_000_000n

/** Yuan multiplier for the shorthand suffixes. */
const MULTIPLIERS = {
  k: 1000n, K: 1000n,
  w: 10000n, W: 10000n,
  千: 1000n, 萬: 10000n, 万: 10000n, 亿: 100000000n, 億: 100000000n,
}

/** Chinese digits, including the everyday/financial variants. */
const CN_DIGITS = {
  零: 0, 〇: 0,
  一: 1, 壹: 1,
  二: 2, 两: 2, 贰: 2,
  三: 3, 叁: 3,
  四: 4, 肆: 4,
  五: 5, 伍: 5,
  六: 6, 陆: 6,
  七: 7, 柒: 7,
  八: 8, 捌: 8,
  九: 9, 玖: 9,
}

/** 十/百/千 are positional multipliers inside a section. */
const CN_SMALL_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 }

/** 万/亿 open a new section. */
const CN_BIG_UNITS = { 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 }

/** Words that mean "I did not really count" — refuse rather than guess (5.5). */
const APPROX_RE = /大概|大约|约摸|约莫|差不多|左右|上下|估计|不确定|可能|也许|多块|多钱|来块|来钱/

/** "三十几", "几十", "几块" — a digit next to 几 is not a number, it is a range. */
const FUZZY_RE = /[0-9零〇一二两三四五六七八九十百千万亿]\s*几|几\s*[0-9十百千万亿块元]/

/** Full-width digits/symbols are what phone keyboards produce. */
const FULL_WIDTH_DIGITS = /[０-９]/g

function fail(code, message) {
  return { ok: false, code, message }
}

/** Normalize a fragment to the characters the matchers care about. */
function normalize(text) {
  return String(text)
    .replace(FULL_WIDTH_DIGITS, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，,]/g, ',')
    .replace(/[￥¥]/g, '¥')
    .replace(/[－—−]/g, '-')
    .replace(/\s+/g, '')
}

/**
 * Turn a plain decimal string in yuan into minor units.
 * Truncates at two decimals (never rounds): "32.567" -> 3256, truncated true.
 */
function fromDecimal(decimal, factor = 1n) {
  const dot = decimal.indexOf('.')
  const intPart = dot === -1 ? decimal : decimal.slice(0, dot)
  const fracPart = dot === -1 ? '' : decimal.slice(dot + 1)
  if (intPart === '' && fracPart === '') return null
  const digits = (intPart === '' ? '0' : intPart) + fracPart
  if (!/^[0-9]+$/.test(digits)) return null
  const numerator = BigInt(digits) * factor * 100n
  const divisor = 10n ** BigInt(fracPart.length)
  return { minor: numerator / divisor, truncated: numerator % divisor !== 0n }
}

/**
 * Colloquial Chinese numerals to an integer amount in yuan.
 * Handles 十/百/千/万/亿 and the spoken shorthand where a bare digit after a
 * unit means "that unit over ten": 一万二 = 12000, 三千五 = 3500, 一百二 = 120.
 * 零 ("一百零八") switches the trailing digit back to the ones place.
 * @returns {number|null} integer yuan, or null when the run is not pure numerals
 */
function chineseToNumber(chars) {
  const list = [...chars]
  let total = 0
  let section = 0
  let number = 0
  let zeroSeen = false
  let lastUnit = 0
  let prevWasUnit = false

  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i]
    const isLast = i === list.length - 1
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
      const digit = CN_DIGITS[ch]
      if (digit === 0) {
        zeroSeen = true
        prevWasUnit = false
        continue
      }
      // "一万二" / "三千五": a bare trailing digit means unit/10.
      if (isLast && prevWasUnit && !zeroSeen && lastUnit >= 100) {
        number = digit * (lastUnit / 10)
      } else {
        number = digit
      }
      prevWasUnit = false
      continue
    }
    if (Object.prototype.hasOwnProperty.call(CN_SMALL_UNITS, ch)) {
      const unit = CN_SMALL_UNITS[ch]
      section += (number || 1) * unit
      number = 0
      lastUnit = unit
      zeroSeen = false
      prevWasUnit = true
      continue
    }
    if (Object.prototype.hasOwnProperty.call(CN_BIG_UNITS, ch)) {
      const unit = CN_BIG_UNITS[ch]
      section += number
      number = 0
      total += (section || 1) * unit
      section = 0
      lastUnit = unit
      zeroSeen = false
      prevWasUnit = true
      continue
    }
    return null
  }
  return total + section + number
}

/** Validate a computed minor amount and shape the success object. */
function succeed(minorBig, raw, truncated) {
  if (minorBig <= 0n) return fail('E_AMOUNT_INVALID', '金额要大于 0')
  if (minorBig > MINOR_CAP) return fail('E_AMOUNT_INVALID', '金额太大了（最多 1000 万元）')
  const minor = Number(minorBig)
  if (!Number.isSafeInteger(minor)) return fail('E_AMOUNT_INVALID', '金额太大了（最多 1000 万元）')
  const result = { ok: true, minor, raw }
  if (truncated) result.truncated = true
  return result
}

/**
 * Parse a money fragment exactly as the user said it.
 *
 * Covered forms (DESIGN 5.2): "32" / "32.5" / "¥32" / "32元" / "32块" /
 * "￥1,280.00" / "三十二块" / "两百" / "一百零八" / "十五" / "1.2k" / "1.5w" /
 * "1万2" / "32块5". Ambiguous ("大概三十几", "差不多50") and impossible
 * amounts ("0", "-5", > 1e9 分) are refused with a code, never guessed.
 *
 * @param {string|number} text raw fragment from the user message
 * @returns {{ok: true, minor: number, raw: string, truncated?: true}
 *   | {ok: false, code: string, message: string}}
 */
export function parseAmount(text) {
  const raw = text === null || text === undefined ? '' : String(text).trim()
  if (raw === '') return fail('E_AMOUNT_MISSING', '这句话里没看到金额')
  if (APPROX_RE.test(raw) || FUZZY_RE.test(raw)) {
    return fail('E_AMOUNT_AMBIGUOUS', '金额不确定（' + raw + '），说个准数我再记')
  }

  let s = normalize(raw)
  if (s === '') return fail('E_AMOUNT_MISSING', '这句话里没看到金额')

  // Currency prefix first, then the sign: "¥-5" is still a negative amount.
  s = s.replace(/^[¥$]/, '')
  if (/^-/.test(s) || /^负/.test(s)) return fail('E_AMOUNT_INVALID', '金额不能是负数')

  // "32块5" / "三十二块五毛" means 32.50, not 32 and 5.
  const spelledCents = /^(.*?)(?:块|元|圆)\s*([0-9一二两三四五六七八九])\s*(?:角|毛)?$/.exec(s)
  if (spelledCents) {
    const major = parseMajorYuan(spelledCents[1])
    if (major) {
      const jiao = Object.prototype.hasOwnProperty.call(CN_DIGITS, spelledCents[2])
        ? CN_DIGITS[spelledCents[2]]
        : Number(spelledCents[2])
      return succeed(major.minor + BigInt(jiao) * 10n, raw, major.truncated)
    }
  }

  // Currency words and thousand separators are noise once we know the scale.
  s = s
    .replace(/(?:人民币|rmb|cny|块钱|元钱|圆钱)$/i, '')
    .replace(/[元块圆钱]$/, '')
    .replace(/^[¥$]/, '')
    .replace(/,/g, '')

  // "1.2k" / "1.5w"
  let m = /^([0-9]+(?:\.[0-9]+)?)([kKwW])$/.exec(s)
  if (m) {
    const parsed = fromDecimal(m[1], MULTIPLIERS[m[2]])
    return parsed ? succeed(parsed.minor, raw, parsed.truncated) : fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
  }

  // "1.2万" / "3千" / "2亿"
  m = /^([0-9]+(?:\.[0-9]+)?)([千万元亿])$/.exec(s)
  if (m) {
    const parsed = fromDecimal(m[1], MULTIPLIERS[m[2]] ?? 10000n)
    return parsed ? succeed(parsed.minor, raw, parsed.truncated) : fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
  }

  // "1万2" = 12000 (not 1.2 万): leading amount plus a spoken tail.
  m = /^([0-9]+(?:\.[0-9]+)?)([万千])([0-9一二两三四五六七八九])([千百])?$/.exec(s)
  if (m) {
    const lead = fromDecimal(m[1], MULTIPLIERS[m[2]])
    if (!lead) return fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
    const tailDigit = Object.prototype.hasOwnProperty.call(CN_DIGITS, m[3])
      ? CN_DIGITS[m[3]]
      : Number(m[3])
    const tailUnit = m[4] ? MULTIPLIERS[m[4]] : (MULTIPLIERS[m[2]] / 10n)
    return succeed(lead.minor + BigInt(tailDigit) * tailUnit * 100n, raw, lead.truncated)
  }

  // Pure Chinese numerals: 三十二 / 两百 / 一百零八 / 十五 / 一万二.
  if (/^[零〇一二两三四五六七八九十百千万亿]+$/.test(s)) {
    const value = chineseToNumber(s)
    if (value === null || !Number.isSafeInteger(value)) {
      return fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
    }
    return succeed(BigInt(value) * 100n, raw, false)
  }

  // Plain decimal: 32 / 32.5 / 1280.00.
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(s)) {
    const parsed = fromDecimal(s)
    return parsed ? succeed(parsed.minor, raw, parsed.truncated) : fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
  }

  return fail('E_AMOUNT_INVALID', '这个金额看不懂：' + raw)
}

/**
 * Parse the yuan part of a "块 + 角" fragment ("三十二块五毛" -> "三十二").
 * Accepts both Chinese numerals and plain decimals.
 * @returns {{minor: bigint, truncated: boolean}|null}
 */
function parseMajorYuan(fragment) {
  const cleaned = String(fragment)
    .replace(/^[¥$]/, '')
    .replace(/,/g, '')
    .replace(/[元块圆]$/, '')
  if (cleaned === '') return null
  if (/^[零〇一二两三四五六七八九十百千万亿]+$/.test(cleaned)) {
    const value = chineseToNumber(cleaned)
    if (value === null || !Number.isSafeInteger(value)) return null
    return { minor: BigInt(value) * 100n, truncated: false }
  }
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) return fromDecimal(cleaned)
  return null
}