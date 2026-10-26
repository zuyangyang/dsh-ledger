#!/usr/bin/env node
/**
 * Load the plugin the way Cordis does — `apply(ctx, config)` — against a fake
 * context, and drive one real sentence through the registered tool. This is the
 * check that catches wiring mistakes that unit tests cannot see: a missing tool
 * registration, a skill that never registers, a journal that never lands.
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-verify-'))
const plugin = await import('../lib/index.js')

const tools = []
const skills = []
const prompts = []
const routes = []
const effects = []
const webCtx = {
  logger: { info: () => {}, warn: () => {} },
  effect: (factory) => effects.push(factory()),
  webServer: { register: ({ path }) => { routes.push(path); return () => {} } },
}
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  tools: { register: (tool) => tools.push(tool) },
  skills: { register: (skill) => skills.push(skill) },
  systemPrompt: { context: (block) => prompts.push(block) },
  agents: { list: () => [] },
  inject: (names, run) => run(webCtx),
  effect: (factory) => effects.push(factory()),
  webServer: webCtx.webServer,
}

const dispose = plugin.apply(ctx, {
  dataDir,
  autoCommit: true,
  nightlyEnabled: false,
  shopName: '皮鞋店',
})

const problems = []
const wantTools = ['ledger_add', 'ledger_query', 'ledger_report', 'ledger_debt', 'ledger_fix', 'ledger_export']
for (const name of wantTools) {
  if (!tools.some((tool) => tool.name === name)) problems.push('missing tool: ' + name)
}
if (skills.length !== 1) problems.push('expected exactly one skill, got ' + skills.length)
if (prompts.length !== 1) problems.push('expected exactly one prompt block, got ' + prompts.length)
if (typeof dispose !== 'function') problems.push('apply() must return a disposer')

const add = tools.find((tool) => tool.name === 'ledger_add')
const result = await add.execute({
  amount: '32',
  note: '午饭',
  source_text: '午饭32<dsh_im_source>{"senderName":"妈"}</dsh_im_source>',
  item_index: 0,
}, {})
if (!result.text || !result.id) problems.push('ledger_add returned no receipt')
if (result.entered_by !== '妈') problems.push('entered_by was not taken from the IM source: ' + result.entered_by)

const journal = join(dataDir, 'entries.ndjson')
if (!existsSync(journal)) problems.push('journal file was not created')
else if (readFileSync(journal, 'utf8').trim().split('\n').length !== 1) problems.push('expected exactly one journal line')

const brief = prompts[0]?.text?.({})
if (typeof brief !== 'string' || brief.length === 0) problems.push('brief prompt rendered empty')
if (existsSync(join(dataDir, '.git')) === false) problems.push('journal directory was not git-initialised')
if (!routes.includes('/api/ledger/summary')) problems.push('dashboard route was not registered')
if (!routes.includes('/api/ledger/config')) problems.push('settings route was not registered')

// The browser half is a prebuilt module, so nothing imports it: check the
// manifest points at a real file that registers under the package id.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientEntry = manifest.exports?.['./client']
const clientPath = typeof clientEntry === 'string' ? clientEntry : clientEntry?.default
if (!clientPath) problems.push('package.json does not export ./client')
else if (!existsSync(join(root, clientPath))) problems.push('client entry is missing: ' + clientPath)
else {
  const source = readFileSync(join(root, clientPath), 'utf8')
  if (!source.includes("id: 'dsh-ledger'")) problems.push('client bundle must load under the package id')
  if (manifest.dsh?.client?.platform !== 'web') problems.push('manifest must declare dsh.client.platform = web')
}
if (manifest.version === undefined) problems.push('package.json has no version')

dispose()

if (problems.length > 0) {
  console.error('FAILED')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}
console.log('OK  tools=' + tools.length + ' skill=' + skills[0].name + ' dataDir=' + dataDir)
console.log('    receipt: ' + result.text.split('\n')[0])