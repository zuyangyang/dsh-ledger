/**
 * dsh-ledger — chat-first bookkeeping for a household and a small shop.
 *
 * Two books, one append-only journal, three readings that never mix: cash that
 * moved, money owed, and (later) margin. Design: DESIGN.md.
 * @module dsh-ledger
 */

import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createRuntime } from './runtime.js'
import { buildBrief } from './brief.js'
import { buildNightly, isDue } from './nightly.js'
import { registerSkill } from './skill.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createAddTool } from './tools/add.js'
import { createDebtTool } from './tools/debt.js'
import { createDoctorTool } from './tools/doctor.js'
import { createExportTool } from './tools/export.js'
import { createFixTool } from './tools/fix.js'
import { createQueryTool } from './tools/query.js'
import { createReportTool } from './tools/report.js'

export const name = 'dsh-ledger'

export const inject = ['tools', 'skills', 'systemPrompt', 'agents']

/** Deployment-owned configuration; runtime toggles live in meta.json. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('~/.dsh/ledger'),
  dayCutoffHour: z.number().default(4),
  defaultBook: z.string().default('home'),
  shopName: z.string().default('店里'),
  defaultActor: z.string().default('yang'),
  actorBookRouting: z.boolean().default(true),
  purchaseSettlementDefault: z.string().default('cash'),
  brief: z.boolean().default(true),
  skill: z.boolean().default(true),
  nightlyEnabled: z.boolean().default(true),
  nightlyTime: z.string().default('21:30'),
  nightlyShopDaily: z.boolean().default(true),
  nightlyHomeWeekly: z.number().default(1),
  autoCommit: z.boolean().default(true),
  commitDebounceSec: z.number().default(60),
  obsidian: z.object({
    enabled: z.boolean().default(true),
    daily: z.boolean().default(true),
    monthly: z.boolean().default(true),
  }).default({ enabled: true, daily: true, monthly: true }),
  diag: z.boolean().default(false),
})

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const runtime = createRuntime({ config: rawConfig, logger: ctx.logger ?? console })
  if (runtime.config.enabled === false) return () => runtime.dispose()

  // A ledger that cannot record is annoying; a plugin that stops the whole app
  // from booting is unacceptable. Each piece registers independently and a
  // failure is logged rather than thrown.
  const loaded = []
  for (const [label, factory] of [
    ['ledger_add', createAddTool],
    ['ledger_query', createQueryTool],
    ['ledger_report', createReportTool],
    ['ledger_debt', createDebtTool],
    ['ledger_fix', createFixTool],
    ['ledger_export', createExportTool],
    ['ledger_doctor', createDoctorTool],
  ]) {
    guard(runtime, 'tool ' + label, () => {
      ctx.tools.register(factory(runtime, defineTool))
      loaded.push(label)
    })
  }

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

  const timer = setInterval(() => {
    try {
      if (!isDue({ now: runtime.now(), config: runtime.config, meta: runtime.store.meta })) return
      const { messages, date } = buildNightly({ runtime })
      if (messages.length === 0) return
      deliver(ctx, runtime, messages, date)
    } catch (error) {
      runtime.logger?.warn?.('[ledger] nightly pass failed:', error?.message ?? error)
    }
  }, 60_000)
  if (typeof timer.unref === 'function') timer.unref()

  runtime.logger?.info?.('[ledger] ready at ' + runtime.config.dataDir + ' (' + runtime.store.all().length +
    ' entries, ' + loaded.length + ' tools)')

  return () => {
    clearInterval(timer)
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

/** Nightly text is saved next to the journal first; delivery is best effort. */
function deliver(ctx, runtime, messages, date) {
  const dir = join(runtime.config.dataDir, 'nightly')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, date + '.md'), messages.map((line) => '- ' + line).join('\n') + '\n', { encoding: 'utf8' })

  let delivered = 0
  try {
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    for (const agent of agents) {
      if (agent?.status !== 'idle') continue
      const content = messages.join('\n')
      agent.followup?.({
        id: 'ledger-nightly-' + date + '-' + agent.id,
        role: 'user',
        content: [{ type: 'text', text: '[ledger 夜间小结]\n' + content }],
        source: { kind: 'plugin:dsh-ledger' },
      })
      delivered += 1
      break
    }
  } catch (error) {
    runtime.logger?.warn?.('[ledger] nightly delivery skipped:', error?.message ?? error)
  }
  runtime.logger?.info?.('[ledger] nightly summary for ' + date + ' (' + delivered + ' delivered)')
  return delivered
}