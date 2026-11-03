/**
 * dsh-ledger — chat-first bookkeeping for a household and a small shop.
 *
 * Two books, one append-only journal, three readings that never mix: cash that
 * moved, money owed, and (later) margin. Design: DESIGN.md.
 * @module dsh-ledger
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { DEFAULT_DATA_DIR_LABEL, defaultDataDir } from './config.js'
import { createRuntime } from './runtime.js'
import { mergeConfig, readUiConfig } from './uiconfig.js'
import { registerWebRoutes } from './web.js'
import { buildBrief } from './brief.js'
import { registerSkill } from './skill.js'
import { createAddTool } from './tools/add.js'
import { createDebtTool } from './tools/debt.js'
import { createClaimTool } from './tools/claim.js'
import { createDoctorTool } from './tools/doctor.js'
import { createExportTool } from './tools/export.js'
import { createFixTool } from './tools/fix.js'
import { createQueryTool } from './tools/query.js'
import { createReportTool } from './tools/report.js'

export const name = 'dsh-ledger'

export const inject = ['tools', 'skills', 'systemPrompt']

/**
 * Deployment-owned configuration; runtime toggles live in meta.json.
 *
 * Every field is described because this block is what a settings page and
 * `--dump-config-schema` render: an unexplained key is a key nobody dares set.
 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('关掉后插件不注册任何工具，账本文件保持原样。'),
  dataDir: z.string().default(defaultDataDir())
    .description('账本目录。支持 ~、$HOME 和相对路径（相对家目录）；默认 '
      + DEFAULT_DATA_DIR_LABEL + '。换目录等于换一本新账，旧数据不会自己搬过去。'),
  dayCutoffHour: z.number().default(4)
    .description('凌晨几点算"新的一天"，默认 4 点：半夜记的账算前一天。'),
  defaultBook: z.string().default('home')
    .description('没说家里还是店里时记哪本账：home | shop。'),
  shopName: z.string().default('店里')
    .description('店里那本账在回执里显示的名字。'),
  identity: z.union([z.const('single'), z.const('auth')]).default('single')
    .description('身份从哪来：single=单人账本，全部可见；auth=接 dsh-family-auth 按成员隔离，'
      + '而且它没加载时账本拒绝出数（不会退化成全部可见）。'),

  imAccounts: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default('~/.dsh/integrations/dsh-weixin/workspaces.json'),
  }).default({ enabled: true, path: '~/.dsh/integrations/dsh-weixin/workspaces.json' })
    .description('用 dsh-im 里微信账号的名字（Yang、Mei）当记账人，优先级高于发送者昵称；'
      + '需要在该账号的上下文增强里启用「机器人标识」字段，否则插件只能按昵称/id 认人。'),
  actorBookRouting: z.boolean().default(true)
    .description('按人记住上次记的账本：妈说"卖了"自动记店里，你说"午饭"自动记家里。'),
  purchaseSettlementDefault: z.string().default('cash')
    .description('进货没提"欠着"时算现结还是赊账：cash | credit。'),
  brief: z.boolean().default(true)
    .description('在对话开头注入一段本月现状（几百字，含"别用旧数当最终答案"的提醒）。'),
  skill: z.boolean().default(true)
    .description('注册记账行为规则（怎么记、回执几行、什么时候不许瞎猜）。'),
  autoCommit: z.boolean().default(true)
    .description('账本目录是 git 仓库，平时自动提交（只本地，绝不 push）。'),
  commitDebounceSec: z.number().default(60)
    .description('最后一次写入后等几秒再提交，避免一句话生成好多个提交。'),
  obsidian: z.object({
    enabled: z.boolean().default(true),
    daily: z.boolean().default(true),
    monthly: z.boolean().default(true),
  }).default({ enabled: true, daily: true, monthly: true })
    .description('导出 Obsidian 能直接看的 markdown（日/月）。'),
  diag: z.boolean().default(false)
    .description('输出更啰嗦的诊断日志。'),
})

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger ?? console
  // Panel-saved settings win over the deployment patch (the panel cannot safely
  // rewrite a YAML file the deployment owns, so it keeps its own file).
  const deploymentConfig = rawConfig ?? {}
  const savedUi = readUiConfig()
  let runtime
  try {
    runtime = createRuntime({ config: mergeConfig(deploymentConfig, savedUi.values), logger })
  } catch (error) {
    // A directory we cannot write must not take the whole app down with it.
    logger?.error?.('[ledger] cannot open the journal at ' + String(rawConfig?.dataDir ?? defaultDataDir()) + ': ' +
      (error?.message ?? error))
    return () => {}
  }
  if (runtime.config.enabled === false) return () => runtime.dispose()

  // A ledger that cannot record is annoying; a plugin that stops the whole app
  // from booting is unacceptable. Each piece registers independently and a
  // failure is logged rather than thrown.
  // dsh-family-auth is optional. When the profile provides it, it owns identity
  // and every read is scoped; when it is absent the ledger behaves exactly as it
  // did before, which is correct for a single-user deployment. Injection is
  // deferred, so the tools close over this mutable runtime rather than a
  // snapshot taken at boot.
  guard(runtime, 'family auth', () => {
    ctx.inject(['familyAuth'], (authCtx) => {
      runtime.auth = authCtx.familyAuth
      runtime.logger?.info?.('[ledger] identity and read scope come from dsh-family-auth')
    })
  })

  const loaded = []
  for (const [label, factory] of [
    ['ledger_add', createAddTool],
    ['ledger_query', createQueryTool],
    ['ledger_report', createReportTool],
    ['ledger_debt', createDebtTool],
    ['ledger_fix', createFixTool],
    ['ledger_export', createExportTool],
    ['ledger_claim', createClaimTool],
    ['ledger_doctor', createDoctorTool],
  ]) {
    guard(runtime, 'tool ' + label, () => {
      ctx.tools.register(factory(runtime, defineTool))
      loaded.push(label)
    })
  }

  // The settings panel needs a data channel; headless deployments have no web
  // server, so this is optional and never blocks the rest of the plugin.
  guard(runtime, 'web routes', () => {
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = registerWebRoutes(webCtx, runtime, { baseConfig: deploymentConfig, uiPath: savedUi.path })
      webCtx.effect(() => dispose, 'dsh-ledger:web-routes')
      webCtx.logger?.info?.('[ledger] settings routes at /api/ledger/*')
    })
  })

  guard(runtime, 'skill', () => registerSkill(ctx, { config: runtime.config }))

  if (runtime.config.brief) {
    guard(runtime, 'brief', () => {
      ctx.systemPrompt.context({
        name: 'dsh-ledger:brief',
        order: 40,
        text: () => buildBrief(runtime),
      })
    })
  }

  runtime.logger?.info?.('[ledger] ready at ' + runtime.config.dataDir + ' (' + runtime.store.all().length +
    ' entries, ' + loaded.length + ' tools)')

  return () => {
    runtime.dispose()
  }
}

/** Run one registration step, reporting instead of throwing. */
function guard(runtime, label, step) {
  try {
    step()
  } catch (error) {
    runtime.logger?.warn?.('[ledger] ' + label + ' failed to register:', error?.message ?? error)
  }
}
