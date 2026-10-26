import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'

import { GitCommitter } from '../lib/git.js'

const hasGit = spawnSync('git', ['--version']).status === 0
const quiet = { warn: () => {} }

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'ledger-git-'))
}

test('init creates a repo and an ignore file', { skip: !hasGit }, () => {
  const dir = freshDir()
  const git = new GitCommitter({ dataDir: dir, logger: quiet }).init()
  assert.equal(git.ready, true)
  assert.equal(existsSync(join(dir, '.git')), true)
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /exports\//)
})

test('flush commits pending changes and then reports clean', { skip: !hasGit }, () => {
  const dir = freshDir()
  const git = new GitCommitter({ dataDir: dir, logger: quiet }).init()
  writeFileSync(join(dir, 'entries.ndjson'), '{"id":"tx_1"}\n')
  const first = git.flush()
  assert.equal(first.committed, true)
  const second = git.flush()
  assert.equal(second.committed, false)
  assert.equal(second.reason, 'clean')
})

test('a disabled committer never touches the directory', { skip: !hasGit }, () => {
  const dir = freshDir()
  const git = new GitCommitter({ dataDir: dir, enabled: false, logger: quiet }).init()
  writeFileSync(join(dir, 'entries.ndjson'), 'x\n')
  assert.deepEqual(git.flush(), { committed: false, reason: 'disabled' })
  assert.equal(existsSync(join(dir, '.git')), false)
})

test('a missing git binary degrades to a warning', () => {
  const dir = freshDir()
  const git = new GitCommitter({
    dataDir: dir,
    logger: quiet,
    run: () => ({ ok: false, stdout: '', stderr: '', error: new Error('spawn git ENOENT') }),
  }).init()
  assert.equal(git.ready, false)
  assert.match(git.lastError, /ENOENT/)
  assert.equal(git.flush().reason, 'no-git')
})

test('commands outside git are never required: only the ignored paths are added', { skip: !hasGit }, () => {
  const dir = freshDir()
  const git = new GitCommitter({ dataDir: dir, logger: quiet }).init()
  writeFileSync(join(dir, 'entries.ndjson'), '{}\n')
  writeFileSync(join(dir, 'noise.tmp'), 'tmp')
  git.flush()
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout
  assert.equal(status.trim(), '')
})
