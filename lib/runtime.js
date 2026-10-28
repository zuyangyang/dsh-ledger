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

/**
 * @param {{config?: object, logger?: object, now?: () => Date}} input
 */
export function createRuntime({ config: rawConfig = {}, logger = console, now = () => new Date() } = {}) {
  const config = normalizeConfig(rawConfig)
  const store = new LedgerStore({ dataDir: config.dataDir, logger }).init()
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

  return {
    config,
    store,
    git,
    otherJournal,
    logger,
    now,
    imAccountNames,
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
}