/**
 * ledger_doctor: what the plugin actually sees and where it writes.
 *
 * Kept because a chat-first ledger must be debuggable from the chat itself: it
 * reports the journal path, counts, quarantine, git state, and — crucially —
 * which fields the tool execution context exposes (that is how `entered_by` gets
 * an automatic source when the message text is not available).
 * @module dsh-ledger/tools/doctor
 */

export function createDoctorTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_doctor',
    description:
      'Diagnostics: where the ledger is stored, how many entries, quarantined lines, git state, '
      + 'and which execution fields are visible to tools. Use it when recording seems to go nowhere or the sender is unknown.',
    parameters: {
      reveal_exec: { type: 'boolean', description: '把这次调用的执行上下文结构也返回（排查 entered_by 用）。' },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const stats = runtime.store.stats()
      const meta = runtime.store.meta
      const lines = [
        '账本目录：' + stats.dataDir,
        '记录：' + stats.entries + ' 条（' + Math.round(stats.bytes / 1024) + ' KB）',
        '隔离行：' + stats.quarantined,
        '默认账本：' + runtime.config.defaultBook + '，默认录入人：' + runtime.config.defaultActor,
        '夜间小结：' + (runtime.config.nightlyEnabled ? runtime.config.nightlyTime : '关闭') +
          '（已发 ' + Object.keys(meta.nightly?.sent || {}).length + ' 次）',
        '自动提交：' + (runtime.config.autoCommit ? runtime.config.commitDebounceSec + ' 秒后' : '关闭') +
          (runtime.git.lastError ? '（git 不可用：' + runtime.git.lastError + '）' : ''),
        '人物表：' + Object.keys(meta.actors || {}).length + ' 人',
      ]
      if (args.reveal_exec) {
        lines.push('执行上下文字段：' + describeShape(exec))
        lines.push('exec.session.id = ' + String(exec?.session?.id ?? exec?.sessionId ?? '(无)'))
      }
      return {
        data_dir: stats.dataDir,
        entries: stats.entries,
        quarantined: stats.quarantined,
        exec_shape: args.reveal_exec ? describeShape(exec) : null,
        text: lines.join('\n'),
      }
    },
  })
}

function describeShape(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return typeof value
  if (seen.has(value) || depth > 2) return '{…}'
  seen.add(value)
  const keys = Object.keys(value).slice(0, 24)
  return '{ ' + keys.map((key) => {
    const child = value[key]
    if (child === null || typeof child !== 'object') return key + ':' + typeof child
    if (typeof child?.id === 'string') return key + '.id=' + child.id
    return key + ':' + describeShape(child, depth + 1, seen)
  }).join(', ') + ' }'
}
/** Tests inject an identity defineTool; the plugin injects the real one. */
const identityDefineTool = (definition) => definition
