/**
 * Keep the ledger directory versioned without ever blocking a write (DESIGN.md 15.6).
 *
 * Commits are debounced: a burst of entries becomes one commit. A missing git
 * binary or an unconfigured identity degrades to a warning, never to a failed
 * record. The plugin never pushes and never touches a remote.
 * @module dsh-ledger/git
 */

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { join } from 'node:path'

import { shanghaiIso } from './util.js'

const GITIGNORE = [
  'exports/',
  'quarantine/',
  '*.tmp',
  '.lock',
  '*.bak',
  '',
].join('\n')

export class GitCommitter {
  /**
   * @param {{dataDir: string, debounceSec?: number, enabled?: boolean, logger?: object, run?: Function}} options
   */
  constructor({ dataDir, debounceSec = 60, enabled = true, logger = console, run = defaultRun }) {
    this.dataDir = dataDir
    this.debounceSec = Math.max(5, Number(debounceSec) || 60)
    this.enabled = enabled !== false
    this.logger = logger
    this.run = run
    this.timer = null
    this.failures = 0
    this.lastError = null
    this.ready = false
    /** Set when the journal sits inside someone else's repository. */
    this.nestedRepo = null
  }

  /** Create the repo and its ignore file once; safe to call repeatedly. */
  init() {
    if (!this.enabled || this.ready) return this
    try {
      const inside = this.run(['rev-parse', '--is-inside-work-tree'], this.dataDir)
      if (inside.ok) {
        // Most books live under a directory that is its own repository. When one
        // is dropped inside somebody else's repository (an Obsidian vault, an IM
        // content folder), committing there would mix the ledger's history into
        // theirs, so we stay read-only and say so once.
        const top = this.run(['rev-parse', '--show-toplevel'], this.dataDir)
        const toplevel = top.ok ? String(top.stdout ?? '').trim() : ''
        if (toplevel && resolve(toplevel) !== resolve(this.dataDir)) {
          this.nestedRepo = toplevel
          this.enabled = false
          this.logger?.warn?.('[ledger] journal is inside the git repository ' + toplevel +
            '; not committing there. Move the journal to a directory of its own (or run git init in it) to get history.')
          return this
        }
      }
      if (!inside.ok) {
        const init = this.run(['init', '-q', '-b', 'main'], this.dataDir)
        if (!init.ok) throw init.error ?? new Error('git init failed')
        this.run(['config', 'user.name', 'dsh-ledger'], this.dataDir)
        this.run(['config', 'user.email', 'ledger@localhost'], this.dataDir)
        const verify = this.run(['rev-parse', '--is-inside-work-tree'], this.dataDir)
        if (!verify.ok) throw verify.error ?? new Error('git init did not take effect')
      }
      const ignorePath = join(this.dataDir, '.gitignore')
      if (!existsSync(ignorePath)) writeFileSync(ignorePath, GITIGNORE, { encoding: 'utf8', mode: 0o600 })
      this.ready = true
    } catch (error) {
      this.note(error)
    }
    return this
  }

  /** Ask for a commit soon; repeated calls inside the window collapse. */
  schedule() {
    if (!this.enabled) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.debounceSec * 1000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Commit immediately (nightly run, shutdown, tests). */
  flush() {
    if (!this.enabled) return { committed: false, reason: 'disabled' }
    this.init()
    if (!this.ready) return { committed: false, reason: 'no-git' }
    const status = this.run(['status', '--porcelain'], this.dataDir)
    if (!status.ok) {
      this.note(status.error)
      return { committed: false, reason: 'status-failed' }
    }
    if (status.stdout.trim().length === 0) return { committed: false, reason: 'clean' }
    this.run(['add', '-A'], this.dataDir)
    const message = 'ledger: ' + shanghaiIso().slice(0, 10) + ' autosave'
    const commit = this.run(['commit', '-q', '-m', message], this.dataDir)
    if (!commit.ok) {
      this.note(commit.error)
      return { committed: false, reason: 'commit-failed' }
    }
    return { committed: true, message }
  }

  note(error) {
    this.failures += 1
    this.lastError = error?.message ?? String(error)
    if (this.failures === 1) this.logger?.warn?.('[ledger] git unavailable, entries still saved:', this.lastError)
  }

  dispose() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.flush()
  }
}

function defaultRun(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.status === 0 ? null : new Error((result.stderr || result.error?.message || 'git failed').trim()),
  }
}