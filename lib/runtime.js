/**
 * One runtime per plugin activation: config, store, git committer and the
 * clock. Tools read from it instead of closing over module state, so a config
 * reload simply builds a new runtime.
 * @module dsh-ledger/runtime
 */

import { GitCommitter } from './git.js'
import { normalizeConfig } from './config.js'
import { LedgerStore } from './store.js'

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
  return {
    config,
    store,
    git,
    logger,
    now,
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
