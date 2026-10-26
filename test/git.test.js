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
test('a journal inside somebody else\'s repository is left alone', () => {
  // /Volumes/.../IM_content is a real repository in the wild; committing the
  // household book into it would mix two histories. Simulate that layout.
  const dir = freshDir()
  const calls = []
  const warnings = []
  const run = (args, cwd) => {
    calls.push(args.join(' '))
    if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', error: null }
    if (args.join(' ') === 'rev-parse --show-toplevel') return { ok: true, stdout: '/somewhere/else/IM_content\n', stderr: '', error: null }
    return { ok: true, stdout: '', stderr: '', error: null }
  }
  const git = new GitCommitter({ dataDir: dir, logger: { warn: (message) => warnings.push(message) }, run }).init()
  assert.equal(git.ready, false)
  assert.equal(git.enabled, false)
  assert.equal(git.nestedRepo, '/somewhere/else/IM_content')
  assert.equal(calls.some((call) => call === 'init -q -b main'), false, 'must not initialise inside a foreign repo')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /not committing there/)
})

test('a journal that owns its repository still commits', () => {
  const dir = freshDir()
  const run = (args, cwd) => {
    const joined = args.join(' ')
    if (joined === 'rev-parse --is-inside-work-tree') return { ok: true, stdout: 'true\n', stderr: '', error: null }
    if (joined === 'rev-parse --show-toplevel') return { ok: true, stdout: cwd + '\n', stderr: '', error: null }
    return { ok: true, stdout: '', stderr: '', error: null }
  }
  const git = new GitCommitter({ dataDir: dir, logger: quiet, run }).init()
  assert.equal(git.ready, true)
  assert.equal(git.nestedRepo, null)
})
