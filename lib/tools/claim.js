/**
 * ledger_claim: move existing records to the member who actually made them.
 *
 * Records written before dsh-family-auth existed carry a guessed `entered_by`
 * and no owner. Once the household has real members, the owner can say "all the
 * ones marked yang are mine" and the side table records that fact. The journal
 * itself is never rewritten.
 * @module dsh-ledger/tools/claim
 */

import { DEFAULT_OWNER, ownerOf } from '../ownership.js'
import { describeRecord } from './shared.js'

const identityDefineTool = (definition) => definition

/**
 * @param {object} runtime - plugin runtime.
 * @param {Function} [defineTool] - injected for tests.
 * @returns {object} the `ledger_claim` tool definition.
 */
export function createClaimTool(runtime, defineTool = identityDefineTool) {
  return defineTool({
    name: 'ledger_claim',
    description: '把历史记录认领给某个家庭成员。用户说"以前记在我名下的都是我"、'
      + '或者要把一堆没人认领的账归给某人时用。只有户主能操作。',
    parameters: {
      member: { type: 'string', required: true, description: '认领给谁：成员表里的名字。' },
      entered_by: { type: 'string', description: '按录入人名字批量认领，比如 yang。' },
      ids: { type: 'array', items: { type: 'string' }, description: '按记录 id 认领（要精确到某几条时用）。' },
      dry_run: { type: 'boolean', description: '只预览会认领多少条，不写。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const view = runtime.view(exec)
      if (!runtime.auth) {
        throw new Error('这个账本没有接入家庭权限（dsh-family-auth），所有记录本来就是同一个人的，不需要认领')
      }
      if (!view.isOwner()) {
        throw new Error('只有户主能认领记录归属')
      }
      const member = runtime.auth.findMember?.(args.member)
      if (!member) {
        throw new Error('成员表里没有「' + args.member + '」；先让户主在对话里把他加上')
      }
      if (!args.entered_by && !Array.isArray(args.ids)) {
        throw new Error('要说清认领哪些：给 entered_by（按录入人名字）或者 ids（按记录 id）')
      }

      const all = view.all()
      const candidates = all.filter((record) => {
        if (ownerOf(record, runtime.owners) === member.id) return false
        if (Array.isArray(args.ids) && args.ids.length > 0) return args.ids.includes(record.id)
        return record.entered_by === args.entered_by
      })

      if (candidates.length === 0) {
        return {
          ok: true,
          claimed: 0,
          text: '没有找到需要认领的记录' + (args.entered_by ? '（录入人是「' + args.entered_by + '」的都已经归好类了）' : '') + '。',
        }
      }

      if (args.dry_run) {
        return {
          ok: true,
          dry_run: true,
          claimed: 0,
          would_claim: candidates.length,
          sample: candidates.slice(0, 5).map((record) => describeRecord(record, runtime.config)),
          text: '会把 ' + candidates.length + ' 条记录认领给「' + member.name + '」，这次只是预览没有写入：'
            + candidates.slice(0, 5).map((record) => describeRecord(record, runtime.config)).join('；')
            + (candidates.length > 5 ? ' …' : ''),
        }
      }

      const written = runtime.claim(
        candidates.map((record) => ({ recordId: record.id, ownerId: member.id })),
        { by: view.actorName(), reason: args.entered_by ? 'claim-entered-by:' + args.entered_by : 'claim-ids' },
      )

      return {
        ok: true,
        claimed: written,
        member: member.name,
        text: '已把 ' + written + ' 条记录认领给「' + member.name + '」。'
          + '从现在起只有' + member.name + '本人（和授权给他的人）能看到这些记录。',
      }
    },
  })
}

export { DEFAULT_OWNER }
