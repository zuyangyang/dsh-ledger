/**
 * Who typed this entry (DESIGN.md 4.8).
 *
 * dsh-im writes a `<dsh_im_source>{"senderName":...,"senderId":...,"botId":...}</dsh_im_source>` block
 * into the message text, so the sender is recoverable from the raw text the
 * model already hands us. Resolution order: an explicit argument that is not
 * just the model echoing the block, then the account name dsh-im shows for the
 * receiving bot ("Yang", "Mei" - the phone that recorded it), then the
 * sender nickname, then the raw account id (dsh-im omits `senderName` on
 * channels and messages without a nickname), then the configured default.
 * Never invent a name: an unknown sender stays `unknown`.
 * @module dsh-ledger/actors
 */

const SOURCE_RE = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/i

/** Values a model likes to pass when it means "I do not know". */
const PLACEHOLDERS = new Set([
  'unknown', 'n/a', 'na', 'none', 'null', 'nil', 'undefined', '-', '—', '--',
  '未知', '匿名', '不知道', '不清楚', '无', '没有', '空', '？', '?',
])

/** Parse the IM source block out of a message, if present. */
export function parseImSource(text) {
  if (typeof text !== 'string') return null
  const match = SOURCE_RE.exec(text)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    if (!parsed || typeof parsed !== 'object') return null
    return {
      channel: typeof parsed.channel === 'string' ? parsed.channel : null,
      conversationType: typeof parsed.conversationType === 'string' ? parsed.conversationType : null,
      // dsh-im emits camelCase, but tolerate snake_case so a hand-written or
      // older block is still usable rather than silently anonymous.
      senderId: firstString(parsed.senderId, parsed.sender_id, parsed.from_id),
      senderName: firstString(parsed.senderName, parsed.sender_name, parsed.from_name),
      conversationTitle: firstString(parsed.conversationTitle, parsed.conversation_title),
      // The receiving account. dsh-im emits it only when the owner enables the
      // botId field in context enhancement, so treat it as optional.
      botId: firstString(parsed.botId, parsed.bot_id),
    }
  } catch {
    return null
  }
}

/** The first value that is a non-empty string (or a number, stringified). */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** Trim and cap an actor name; invisible padding and "unknown" become null. */
export function normalizeActor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value)
  if (typeof value !== 'string') return null
  const trimmed = value
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
  if (trimmed.length === 0) return null
  if (PLACEHOLDERS.has(trimmed.toLowerCase())) return null
  return trimmed.slice(0, 64)
}

/**
 * Resolve the actor for one entry and remember which book they used.
 * @param {{enteredBy?: string, sourceText?: string, meta?: object, config?: object,
 *   imAccountName?: ((botId: (string|null)) => (string|null))|null}} input
 */
export function resolveActor({ enteredBy, sourceText, config = {}, imAccountName = null } = {}) {
  const im = parseImSource(sourceText)
  const explicit = normalizeActor(enteredBy)
  // A model that copies senderName/senderId into the argument is not making a
  // choice, it is repeating the block. Passing that through would defeat the
  // account name, so echoing the source counts as "no argument".
  const echoed = explicit !== null && im !== null
    && (explicit === normalizeActor(im.senderName) || explicit === normalizeActor(im.senderId))
  if (explicit !== null && !echoed) {
    return { actor: explicit, actorSource: 'param', actorField: 'param', imSource: im }
  }

  // The account name first: the two connected WeChat accounts are how the
  // household tells the phones apart, while the sender is the same person.
  const account = im && typeof imAccountName === 'function' ? normalizeActor(imAccountName(im.botId)) : null
  if (account) return { actor: account, actorSource: 'im_account', actorField: 'account', imSource: im }

  const name = normalizeActor(im?.senderName)
  if (name) return { actor: name, actorSource: 'im_source_name', actorField: 'name', imSource: im }

  // No nickname (dsh-im omits senderName when a channel cannot supply one):
  // the account id is still a stable identity, and "who typed this" beats
  // "nobody". It is uglier, but it is true.
  const id = normalizeActor(im?.senderId)
  if (id) return { actor: id, actorSource: 'im_source_id', actorField: 'id', imSource: im }

  // Nothing identified the speaker. The record still goes into the journal,
  // but under the shared bucket, and the receipt says so instead of inventing
  // a name.
  return { actor: '未识别', actorSource: 'unidentified', actorField: null, imSource: im }
}

/**
 * Pick the book for this entry: explicit word first, then what this actor used
 * last, then the configured default. Never guess "shop" just because the
 * sentence mentions shoes.
 */
export function resolveBook({ explicitBook, actor, store, config = {} } = {}) {
  if (explicitBook === 'shop' || explicitBook === 'home') {
    return { book: explicitBook, bookSource: 'explicit' }
  }
  const remembered = config.actorBookRouting && actor && store ? store.lastBookForActor(actor) : null
  if (remembered === 'shop' || remembered === 'home') {
    return { book: remembered, bookSource: 'remembered' }
  }
  return { book: config.defaultBook === 'shop' ? 'shop' : 'home', bookSource: 'default' }
}