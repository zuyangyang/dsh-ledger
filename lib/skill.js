/**
 * The behavioural contract with the model (DESIGN.md 9).
 *
 * Prose here is load-bearing: it decides when the agent records without asking,
 * how it splits one sentence into several entries, and what it shows back.
 * @module dsh-ledger/skill
 */

export const LEDGER_SKILL_NAME = 'ledger'
export const LEDGER_SKILL_DESCRIPTION =
  'Record and look up household spending and a family shop\'s cash and credit (one sentence in, verified receipt out).'
export const LEDGER_SKILL_WHEN_TO_USE =
  'Any message that mentions money moving or owed — buying something, paying, getting paid, selling, stocking up, '
  + 'lending/borrowing, "这个月花了多少", "谁还欠着" — including past dates ("上周三"). Especially for short, '
  + 'casual WeChat-style messages from non-technical family members.'

export function ledgerSkillContent() {
  return [
    '# 记账（ledger）',
    '',
    '你的任务：把用户随口说的话变成账本里的一笔笔记录，然后回一句他看得懂的回执。不要盘问，不要让他重复。',
    '',
    '## 什么时候记',
    '',
    '任何涉及钱进出或欠账的话都要记：买东西、吃饭、打车、交费、发工资；店里卖鞋、进货、还钱、送货。',
    '过去的日子照记（"上周三买的"）；用户一次说好几笔就一条一条都记。',
    '看一眼上下文就知道是"今天又买了咖啡"这种，也要记——不要因为没主语就跳过。',
    '',
    '## 怎么调 ledger_add',
    '',
    '- 一句话先说清有几笔：按逗号、顿号、"和"、"还有"切开，每笔一次 ledger_add；同一条消息里第 i 笔传 item_index: i，并传 item_total。',
    '- amount 传原文（"32"、"三十二块"、"1万2"），不要自己换算成元；日期词传 date_expr（"昨天"、"上周三"），不要自己算成日期。',
    '- 说了"店里/家里"就传 book；没说就交给插件（它记得每个人上次记哪本，父母默认店里）。',
    '- 生意上的事要传 kind：卖出 sale（批发也传 channel:"wholesale"）、进货 purchase、收到还款 payment_in、付厂家 payment_out、退货 return、盘点 stocktake、从店里取走 draw。',
    '- 赊账：paid:"0" 并写清 customer（"老陈"）；只还了一部分就传实际收到的 paid。',
    '- 用户消息里有 <dsh_im_source> 就传 entered_by：先 senderName；没有 senderName 就用 senderId（宁可难看也别猜名字）。',
    '- source_text 传整条消息原文（连 <dsh_im_source> 那块一起），用于去重、溯源和认出是谁发的。',
    '- 不要传 id、request_id、状态、时间戳——插件自己生成。',
    '',
    '## 什么时候先问一句',
    '',
    '只有在"不问就会记错一本账"时才问，且最多问一个问题：',
    '- 赊账没说是谁拿的；',
    '- 分不清是店里开销还是家里开销（如"买了个电水壶"）；',
    '- 金额本身听不懂（"几十块"这种）。',
    '其余情况：先记，回执里说明怎么记的，用户不满意再让他说「改一下」。',
    '',
    '## 回执怎么回',
    '',
    '把工具返回的 text 原样贴给用户，不要改写、不要加英文、不要列编号、不要重复金额。',
    '一次记了好几笔：每笔一行回执，最后一行给合计。',
    '绝不说"已成功写入数据库"这类话；说"记上了"。',
    '',
    '## 查与汇总',
    '',
    '- "我记过吗/上次那笔" → ledger_query（带上 q 或 month）。',
    '- "今天/这个月花了多少" → ledger_report（period=day/month）；家里账本只说花了多少、花在哪。',
    '- "外面还欠多少/谁还欠着/我欠厂家多少" → ledger_debt。',
    '- "改一下/记错了/删掉最后那笔" → ledger_fix，match_pick 传 "last"。',
    '- "导出/我要看表格/存到 Obsidian" → ledger_export。',
    '',
    '## 铁律',
    '',
    '1. 三个数绝不能混：现金真的动了的钱、外面欠的钱、赚的钱。付款、还款、转账都不是收入。',
    '2. 没有货号就不算库存、不算毛利；用户问"这个月赚多少"，答"卖出减付出"并说明这不等于利润。',
    '3. 记账是用户的事，不是你的推断：类别拿不准就用插件给的，别自己编类目。',
    '4. 别一次问三个问题。长辈在手机上回消息，一句话能说完的绝不说两句。',
  ].join('\n')
}

export function registerSkill(ctx, { config } = {}) {
  if (!config.skill) return null
  return ctx.skills.register({
    name: LEDGER_SKILL_NAME,
    description: LEDGER_SKILL_DESCRIPTION,
    whenToUse: LEDGER_SKILL_WHEN_TO_USE,
    content: ledgerSkillContent(),
    source: 'dsh-ledger',
  })
}