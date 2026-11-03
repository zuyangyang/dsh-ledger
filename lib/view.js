/**
 * The one place a tool may read the journal through.
 *
 * Every read in this plugin goes through a view built from the execution that
 * asked for it. A view answers two questions: which records may this execution
 * see, and whose name goes on a new record. When dsh-family-auth is not
 * installed the view is unrestricted, which is exactly the old single-user
 * behaviour.
 *
 * The point of routing everything through one object is that forgetting to
 * filter becomes a missing method rather than a silently unfiltered query.
 * `scripts/guard-scope.mjs` enforces that nothing reaches around it.
 * @module dsh-ledger/view
 */

import { DEFAULT_OWNER, ownerOf } from './ownership.js'

/** Module name registered with dsh-family-auth. */
export const AUTH_MODULE = 'ledger'

/**
 * Build the view for one tool execution.
 * @param {object} runtime - plugin runtime.
 * @param {object} exec - DSH tool execution (may be undefined in tests).
 * @returns {object} the scoped view.
 */
export function createView(runtime, exec) {
  const auth = runtime.auth || null
  let resolved = false
  let scope = null

  /** Resolve the scope once per view; readScope also writes one audit row. */
  function resolve() {
    if (resolved) return
    resolved = true
    if (!auth) {
      // The deployment said identity comes from dsh-family-auth, but the service
      // never arrived. Refusing is the only safe answer: falling back to "no
      // filtering" here would hand every member everyone's rows, silently, in
      // exactly the deployment that asked for isolation.
      if (runtime.config?.identity === 'auth') {
        throw new Error('家庭权限未就绪：配置要求用 dsh-family-auth，但它的服务没有加载；'
          + '先在 profile 里启用 dsh-family-auth，或把 identity 改成 single')
      }
      scope = null
      return
    }
    try {
      scope = auth.readScope(exec, AUTH_MODULE)
    } catch (error) {
      // A guard that cannot answer must not hand back data.
      scope = new Set()
      runtime.logger?.warn?.('[ledger] read scope unavailable: ' + (error?.message ?? error))
    }
  }

  function allowed(record) {
    resolve()
    if (scope === null) return true
    return scope.has(ownerOf(record, runtime.owners))
  }

  const view = {
    /** True when dsh-family-auth is driving identity. */
    get authActive() {
      return Boolean(auth)
    },

    /** `null` for unrestricted, otherwise the visible owner ids. */
    get scope() {
      resolve()
      return scope
    },

    /** Owner id of one record, resolved through the side table when needed. */
    ownerOf(record) {
      return ownerOf(record, runtime.owners)
    },

    /**
     * Every record this execution may see.
     * @returns {object[]} journal records.
     */
    all() {
      const records = runtime.store.all()
      resolve()
      if (scope === null) return records
      return records.filter((record) => scope.has(ownerOf(record, runtime.owners)))
    },

    /**
     * One record by id, or null when it is outside the view.
     *
     * Returning null rather than throwing is deliberate: "找不到" is the honest
     * answer for a record the caller may not see, and it keeps the tools' own
     * error messages intact.
     * @param {string} id - record id.
     * @returns {object|null} the record.
     */
    byId(id) {
      if (typeof id !== 'string' || id.length === 0) return null
      const record = view.all().find((item) => item.id === id)
      return record || null
    },

    /**
     * Whether this execution may touch one record.
     * @param {object} record - journal record.
     * @returns {boolean} true when visible.
     */
    can(record) {
      if (!record) return false
      return allowed(record)
    },

    /**
     * The name to print on a receipt: the member who is speaking.
     * @returns {string|null} member name, or null when no identity is available.
     */
    actorName() {
      if (!auth) return null
      try {
        const actor = auth.actorOf(exec)
        return actor ? actor.name : null
      } catch {
        return null
      }
    },

    /**
     * Stamp for a new record: whose name it goes under.
     *
     * With dsh-family-auth this asks the guard, which falls back to the shared
     * bucket for an unidentified conversation. Without it, everything belongs to
     * the single user and lands in that same bucket.
     * @returns {{ownerId: string, ownerName: string, anonymous: boolean}} stamp.
     */
    stamp() {
      if (!auth) {
        return { ownerId: DEFAULT_OWNER, ownerName: '未识别', anonymous: true }
      }
      const result = auth.mustWrite(exec, AUTH_MODULE)
      return {
        ownerId: result.ownerId,
        ownerName: auth.ownerLabel(result.ownerId),
        anonymous: Boolean(result.anonymous),
      }
    },

    /**
     * Whether the caller is the household owner.
     * @returns {boolean} true for the owner.
     */
    isOwner() {
      if (!auth) return true
      const actor = auth.actorOf(exec)
      return Boolean(actor && actor.role === 'owner')
    },
  }

  return view
}
