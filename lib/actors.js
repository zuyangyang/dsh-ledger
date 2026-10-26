/**
 * Who typed this entry (DESIGN.md 4.8).
 *
 * dsh-im writes a `<dsh_im_source>{"senderName":…,"senderId":…}</dsh_im_source>` block
 * into the message text, so the sender is recoverable from the raw text the
 * model already hands us. Resolution order: explicit argument, that block,
 * the book this actor used last, then the configured default. Never invent a
 * name: an unknown sender stays `unknown`.
 * @module dsh-ledger/actors
 */

const SOURCE_RE = /<dsh_im_source>([\s\S]*?)<\/dsh_im_source>/i

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
      senderId: parsed.senderId === undefined || parsed.senderId === null ? null : String(parsed.senderId),
      senderName: typeof parsed.senderName === 'string' ? parsed.senderName : null,
      conversationTitle: typeof parsed.conversationTitle === 'string' ? parsed.conversationTitle : null,
    }
  } catch {
    return null
  }
}

/** Trim and cap a display name; empty becomes null. */
export function normalizeActor(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64)
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Resolve the actor for one entry and remember which book they used.
 * @param {{enteredBy?: string, sourceText?: string, meta?: object, config?: object}} input
 */
export function resolveActor({ enteredBy, sourceText, config = {} } = {}) {
  const explicit = normalizeActor(enteredBy)
  if (explicit) return { actor: explicit, actorSource: 'param', imSource: parseImSource(sourceText) }
  const im = parseImSource(sourceText)
  const fromIm = normalizeActor(im?.senderName) || normalizeActor(im?.senderId)
  if (fromIm) return { actor: fromIm, actorSource: 'im_source', imSource: im }
  const fallback = normalizeActor(config.defaultActor)
  return { actor: fallback || 'unknown', actorSource: 'default', imSource: im }
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
