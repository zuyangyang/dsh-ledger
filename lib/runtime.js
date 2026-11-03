/**
 * One runtime per plugin activation: config, store, git committer and the
 * clock. Tools read from it instead of closing over module state, so a config
 * reload simply builds a new runtime.
 * @module dsh-ledger/runtime
 */

import { GitCommitter } from './git.js'
import { createImAccountNames } from './imaccounts.js'
import { normalizeConfig } from './config.js'
import { LedgerStore, peekJournal } from './store.js'
import { appendOwnership, loadOwnership } from './ownership.js'
import { createView } from './view.js'

/**
 * @param {{config?: object, logger?: object, now?: () => Date}} input
 */
export function createRuntime({ config: rawConfig = {}, logger = console, now = () => new Date() } = {}) {
  const config = normalizeConfig(rawConfig)
  const store = new LedgerStore({ dataDir: config.dataDir, logger }).init()
  // Ownership of records that predate the side table, plus any later correction.
  const owners = loadOwnership(config.dataDir)
  const git = new GitCommitter({
    dataDir: config.dataDir,
    debounceSec: config.commitDebounceSec,
    enabled: config.autoCommit,
    logger,
  })
  git.init()

  // Who recorded it: dsh-im knows the names the owner gave its WeChat accounts,
  // and publishes the account id in the source block. Read them lazily so a
  // rename in dsh-im arrives without a DSH restart.
  const imAccountNames = createImAccountNames({
    path: config.imAccounts.path,
    enabled: config.imAccounts.enabled,
    logger,
  })

  // Switching dataDir is legitimate but easy to do by accident; if the default
  // directory still holds history, say where it is instead of acting surprised.
  const otherJournal = config.dataDirIsDefault ? null : peekJournal(config.defaultDataDir)
  if (otherJournal && otherJournal.entries > 0) {
    logger?.warn?.('[ledger] using ' + config.dataDir + ', but ' + otherJournal.dir + ' still holds ' +
      otherJournal.entries + ' entries; copy it over with: cp -a ' + otherJournal.dir + '/. ' + config.dataDir + '/')
  }

  const runtime = {
    config,
    store,
    git,
    otherJournal,
    logger,
    now,
    imAccountNames,
    /**
     * dsh-family-auth service, attached by the plugin entry point when present.
     * Null means "single user": every read is unrestricted, which is the old
     * behaviour and exactly right for a one-person deployment.
     */
    auth: null,
    /** Side table: record id to owner id. */
    owners,
    /**
     * The scoped read view for one execution. Tools must not touch `store.all()`
     * directly; `scripts/guard-scope.mjs` fails the build when they do.
     */
    view(exec) {
      return createView(runtime, exec)
    },
    /**
     * Record ownership for existing records (migration and reassignment).
     * @param {Array<{recordId: string, ownerId: string}>} entries - facts to append.
     * @param {{by?: string, reason?: string}} [meta] - who decided and why.
     * @returns {number} how many were written.
     */
    claim(entries, meta = {}) {
      const at = new Date().toISOString()
      const stamped = entries.map((entry) => ({
        recordId: entry.recordId,
        ownerId: entry.ownerId,
        at,
        by: meta.by || null,
        reason: meta.reason || 'claim',
      }))
      const written = appendOwnership(config.dataDir, stamped)
      for (const entry of stamped) owners.set(entry.recordId, entry.ownerId)
      return written
    },
    /** The name dsh-im shows for the account that delivered this message. */
    imAccountName(botId) {
      return imAccountNames.nameFor(botId)
    },
    /** Persist, then queue a version-control save. */
    persist(records) {
      const result = store.append(records)
      if (result.written.length > 0) git.schedule()
      return result
    },
    revise(id, patch, options) {
      const result = store.revise(id, patch, options)
      git.schedule()
      return result
    },
    dispose() {
      git.dispose()
    },
  }

  return runtime
}