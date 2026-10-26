/**
 * Built-in taxonomy and keyword classification (DESIGN.md 6).
 *
 * Book ownership is encoded in the slug prefix: `biz_*` may only appear in the
 * shop book, the twelve home slugs only in the home book. A classification that
 * crosses books is refused instead of quietly reported under the wrong book.
 * @module dsh-ledger/categories
 */

/** Home spending L1 -> display label, in report order. */
export const HOME_EXPENSE = {
  food: '餐饮',
  transport: '交通',
  housing: '居住',
  shopping: '购物',
  health: '医疗',
  entertainment: '娱乐',
  education: '学习',
  communication: '通讯',
  social: '人情',
  travel: '旅行',
  pet: '宠物',
  other: '其他',
}

/** Home income L1. */
export const HOME_INCOME = {
  salary: '工资',
  bonus: '奖金',
  investment: '理财',
  reimburse: '报销',
  gift: '红包',
  other_income: '其他收入',
}

/** Shop taxonomy; `biz_cashflow` never counts as income or expense. */
export const BIZ = {
  biz_revenue: '营业收入',
  biz_other_income: '营业外收入',
  biz_rent: '房租',
  biz_utilities: '水电',
  biz_packaging: '包装',
  biz_shipping: '运费',
  biz_labor: '人工',
  biz_repair: '维修',
  biz_marketing: '广告',
  biz_entertain: '招待',
  biz_transport: '拉货',
  biz_fee: '杂费',
  biz_loss: '损耗',
  biz_other: '其他支出',
  biz_cashflow: '资金流转',
}

const HOME_KEYWORDS = [
  ['food', '餐饮', ['饭', '午饭', '晚饭', '早饭', '早餐', '午餐', '晚餐', '夜宵', '吃', '外卖', '咖啡', '奶茶', '饮料', '菜', '买菜', '超市', '水果', '零食', '食堂', '火锅', '面', '粉', '包子', '饺子']],
  ['transport', '交通', ['打车', '出租', '地铁', '公交', '高铁', '火车', '机票', '飞机', '加油', '停车', '过路', '共享单车', '滴滴']],
  ['housing', '居住', ['房租', '物业', '水费', '电费', '燃气', '煤气', '取暖', '房贷', '保洁']],
  ['shopping', '购物', ['衣服', '鞋', '裤', '外套', '日用品', '纸巾', '洗衣液', '家具', '家电', '数码', '耳机', '快递']],
  ['health', '医疗', ['医院', '药', '挂号', '体检', '门诊', '牙', '看病', '针']],
  ['entertainment', '娱乐', ['电影', '游戏', '演出', '门票', '唱歌', 'ktv', '会员', '视频']],
  ['education', '学习', ['书', '课', '学费', '培训', '考试', '教材', '网课']],
  ['communication', '通讯', ['话费', '流量', '宽带', '手机费']],
  ['social', '人情', ['红包', '礼金', '随礼', '份子', '请客', '送礼']],
  ['travel', '旅行', ['酒店', '民宿', '旅游', '景点', '门票', '签证']],
  ['pet', '宠物', ['猫粮', '狗粮', '宠物', '疫苗']],
]

const HOME_INCOME_KEYWORDS = [
  ['salary', '工资', ['工资', '薪水', '月薪', '发薪']],
  ['bonus', '奖金', ['奖金', '年终', '提成']],
  ['investment', '理财', ['利息', '分红', '理财', '收益', '股票']],
  ['reimburse', '报销', ['报销']],
  ['gift', '红包', ['红包', '压岁', '礼金']],
]

const BIZ_KEYWORDS = [
  ['biz_rent', '房租', ['店租', '房租', '铺租', '租金']],
  ['biz_utilities', '水电', ['电费', '水费', '燃气', '物业', '取暖']],
  ['biz_packaging', '包装', ['鞋盒', '包装', '袋子', '纸箱']],
  ['biz_shipping', '运费', ['运费', '快递', '物流', '发货']],
  ['biz_labor', '人工', ['工资', '工钱', '雇', '店员', '提成']],
  ['biz_repair', '维修', ['修', '装修', '维修', '换灯']],
  ['biz_marketing', '广告', ['广告', '招牌', '宣传', '海报']],
  ['biz_entertain', '招待', ['请客', '吃饭', '招待', '烟', '酒']],
  ['biz_transport', '拉货', ['拉货', '油费', '加油', '过路', '停车']],
  ['biz_fee', '杂费', ['手续费', '管理费', '市场', '卫生费', '税']],
  ['biz_loss', '损耗', ['损耗', '盘亏', '丢了', '坏了']],
]

/** Normalize free text for keyword matching. */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '')
}

function matchLongest(text, table, book) {
  const haystack = normalize(text)
  if (!haystack) return null
  let best = null
  for (const [l1, label, keywords] of table) {
    for (const keyword of keywords) {
      if (!haystack.includes(normalize(keyword))) continue
      if (!best || keyword.length > best.keyword.length) best = { l1, label, keyword, book }
    }
  }
  return best
}

/**
 * Classify a sentence into a category slug.
 *
 * Unknown text becomes `other` (never a guess), and a caller-supplied category
 * wins only when it is legal for the book.
 * @param {{text?: string, book?: string, kind?: string, l1?: string, l2?: string, aliases?: object}} input
 */
export function classify({ text = '', book = 'home', kind = 'expense', l1, l2, aliases = {} } = {}) {
  const aliasHit = matchAlias(text, book, aliases)
  if (aliasHit) return { l1: aliasHit.l1, l2: aliasHit.l2 ?? null, source: 'alias', confidence: 0.97 }

  if (l1 && isLegalForBook(l1, book)) {
    return { l1, l2: l2 ?? null, source: 'hint', confidence: 0.9 }
  }

  if (book === 'shop') {
    const hit = matchLongest(text, BIZ_KEYWORDS, book)
    if (hit) return { l1: hit.l1, l2: null, source: 'builtin', confidence: 0.85 }
    if (kind === 'sale') return { l1: 'biz_revenue', l2: null, source: 'builtin', confidence: 0.9 }
    if (kind === 'purchase') return null
    if (['payment_in', 'payment_out', 'draw', 'transfer'].includes(kind)) {
      return { l1: 'biz_cashflow', l2: null, source: 'builtin', confidence: 1 }
    }
    return null
  }

  if (kind === 'income') {
    const hit = matchLongest(text, HOME_INCOME_KEYWORDS, book)
    const found = hit ?? { l1: 'other_income', label: '其他收入' }
    return { l1: found.l1, l2: null, source: hit ? 'builtin' : 'fallback', confidence: hit ? 0.85 : 0.4 }
  }
  const hit = matchLongest(text, HOME_KEYWORDS, book)
  const found = hit ?? { l1: 'other', label: '其他' }
  return { l1: found.l1, l2: null, source: hit ? 'builtin' : 'fallback', confidence: hit ? 0.85 : 0.35 }
}

/** Aliases are keyed by book so "吃饭" means different things in each book. */
export function matchAlias(text, book, aliases) {
  const haystack = normalize(text)
  if (!haystack || !aliases || typeof aliases !== 'object') return null
  let best = null
  for (const [pattern, target] of Object.entries(aliases)) {
    const [patternBook, word] = pattern.includes('|') ? pattern.split('|') : [book, pattern]
    if (patternBook !== book || !word) continue
    if (!haystack.includes(normalize(word))) continue
    if (!best || word.length > best.word.length) best = { word, l1: target?.l1, l2: target?.l2 ?? null }
  }
  return best
}

/** True when a slug belongs to the given book. */
export function isLegalForBook(l1, book) {
  if (!l1) return true
  if (book === 'shop') return l1.startsWith('biz_')
  return !l1.startsWith('biz_')
}

/** Display label for a slug, with the slug kept for stable diffs. */
export function labelOf(l1) {
  return HOME_EXPENSE[l1] || HOME_INCOME[l1] || BIZ[l1] || l1 || ''
}
