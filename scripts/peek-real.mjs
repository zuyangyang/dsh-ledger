
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { LedgerStore } from '../lib/store.js'
import { buildRangeDashboard, actorNamesOf } from '../lib/range.js'

const copy = mkdtempSync(join(tmpdir(), 'ledger-crash-'))
cpSync('/Volumes/Zuyang/dsh/IM_content/ledger', copy, { recursive: true })
const store = new LedgerStore({ dataDir: copy, logger: { warn() {}, error() {}, info() {} } })
const make = (group) => buildRangeDashboard({
  records: store.all(),
  config: { defaultBook: 'home', defaultActor: 'Mei' },
  stats: store.stats(),
  git: { enabled: true, ready: true, lastError: null, nestedRepo: null },
  group,
  book: 'all',
  actorNames: actorNamesOf(store.meta),
  now: new Date('2026-10-28T10:00:00+08:00'),
})

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(6).filter((c) => c !== null && c !== undefined && c !== false)
      const merged = { ...(props || {}) }
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      return { type, props: merged, children: flat }
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useCallback(fn) { return fn },
    useEffect() {},
  }
}

let entry = null
vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load: (v) => { entry = v } } } })
const module = entry.factory((name) => { if (name === 'react') return fakeReact(); throw new Error('require ' + name) })
const { LedgerDock } = module.__test

const view = (group) => ({ preset: 'last30', from: '2026-09-29', to: '2026-10-28', group, book: 'all' })
for (const group of ['book', 'actor']) {
  const payload = make(group)
  try {
    const tree = LedgerDock({
      open: true, data: payload, view: view(group),
      onOpen: () => {}, onClose: () => {}, onRefresh: () => {}, onRename: () => {},
      onPreset: () => {}, onCustomFrom: () => {}, onCustomTo: () => {}, onGroup: () => {}, onBook: () => {},
    })
    console.log(group, 'OK parts', Array.isArray(tree) ? tree.length : 'not-array')
  } catch (failure) {
    console.log(group, 'CRASH:', failure && failure.stack ? failure.stack.split('\n').slice(0, 6).join('\n') : failure)
  }
  if (group === 'book') console.log('payload keys', Object.keys(payload), 'series point', JSON.stringify(payload.series.points.find((p) => p.count > 0)))
  if (group === 'actor') console.log('actor 0 keys', JSON.stringify(Object.keys(payload.actors[0] || {})), 'point', JSON.stringify((payload.actors[0] || { points: [] }).points.find((p) => p.minor > 0)))
}
