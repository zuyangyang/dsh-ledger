
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { LedgerStore } from '../lib/store.js'
import { buildRangeDashboard, actorNamesOf } from '../lib/range.js'

const copy = mkdtempSync(join(tmpdir(), 'ledger-actor-'))
cpSync('/Volumes/Zuyang/dsh/IM_content/ledger', copy, { recursive: true })
const store = new LedgerStore({ dataDir: copy, logger: { warn() {}, error() {}, info() {} } })
const payload = buildRangeDashboard({
  records: store.all(), config: { defaultBook: 'home', defaultActor: 'Mei' }, stats: store.stats(),
  git: { enabled: true, ready: true, lastError: null, nestedRepo: null },
  group: 'actor', book: 'all', actorNames: actorNamesOf(store.meta), now: new Date('2026-10-28T10:20:00+08:00'),
})
console.log('actor points shape:', JSON.stringify(payload.actors[0].points.slice(0, 2)))

function fakeReact() {
  return {
    createElement(type, props, ...children) {
      const flat = children.flat(6).filter((c) => c !== null && c !== undefined && c !== false)
      const merged = { ...(props || {}) }
      if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
      return { type, props: merged, children: flat }
    },
    useState(initial) { return [initial, () => {}] },
    useCallback(fn) { return fn },
    useEffect() {},
  }
}
let entry = null
vm.runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load: (v) => { entry = v } } } })
const module = entry.factory((name) => { if (name === 'react') return fakeReact(); throw new Error(name) })
try {
  module.__test.LedgerDock({
    open: true, data: JSON.parse(JSON.stringify(payload)), view: { preset: 'last30', from: '2026-09-29', to: '2026-10-28', group: 'actor', book: 'all' },
    onOpen: () => {}, onClose: () => {}, onRefresh: () => {}, onRename: () => {},
    onPreset: () => {}, onCustomFrom: () => {}, onCustomTo: () => {}, onGroup: () => {}, onBook: () => {},
  })
  console.log('actor render: no crash')
} catch (failure) {
  console.log('actor render CRASH:', failure.message)
}
