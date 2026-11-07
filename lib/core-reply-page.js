/** Stateless, read-only reply pagination. Cursors locate data, never grant access. */
import { createHash } from 'node:crypto'
import { collectReply } from './core-reply.js'
import { collectDeliveryReply } from './core-delivery.js'
import { REPLY_TEXT_MAX } from './core-contract.js'

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })
const digest = (text) => createHash('sha256').update(text).digest('hex')
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const failure = (pageError) => ({ pageError })

/** Prefer grapheme boundaries; exceptionally large clusters fall back to code points. */
function boundaries(text) {
  const out = [0]
  for (const { segment, index } of segmenter.segment(text)) {
    if (segment.length > REPLY_TEXT_MAX) {
      let offset = index
      for (const point of segment) { offset += point.length; out.push(offset) }
    } else out.push(index + segment.length)
  }
  return out
}

/** Read the first or a continued page against one immutable visible-text snapshot. */
export function pageReply({ events, workspaceId, sessionId, snapshotSeq, afterSeq = -1, deliveryMessageId, inheritedEventCount = 0, cursor }) {
  if (!Number.isSafeInteger(Math.trunc(afterSeq))) return failure('invalid-after-seq')
  afterSeq = Math.max(-1, Math.trunc(afterSeq))
  let token
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return failure('invalid-cursor')
    try { token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { return failure('invalid-cursor') }
    if (!token || token.v !== 1 || typeof token.workspaceId !== 'string' || typeof token.sessionId !== 'string'
      || !Number.isSafeInteger(token.replySeq) || token.replySeq < 0
      || !Number.isSafeInteger(token.snapshotSeq) || token.snapshotSeq < token.replySeq
      || !Number.isSafeInteger(token.afterSeq) || token.afterSeq < -1 || token.afterSeq >= token.replySeq
      || !Number.isSafeInteger(token.offset) || token.offset <= 0 || !/^[a-f0-9]{64}$/.test(token.hash)
      || (token.deliveryMessageId !== undefined && typeof token.deliveryMessageId !== 'string')) return failure('invalid-cursor')
    if (token.workspaceId !== workspaceId || token.sessionId !== sessionId) return failure('wrong-target')
    if (snapshotSeq < token.snapshotSeq) return failure('snapshot-unavailable')
    afterSeq = token.afterSeq
    deliveryMessageId = token.deliveryMessageId
  }
  const boundary = token?.snapshotSeq ?? snapshotSeq
  const snapshot = events.filter((e) => e.seq <= boundary)
  // Require the saved boundary still to exist, not merely a newer cursor value.
  const reply = deliveryMessageId === undefined
    ? { afterSeq, ...collectReply({ events: snapshot, afterSeq, maxChars: Infinity }) }
    : collectDeliveryReply({ events: snapshot, messageId: deliveryMessageId, inheritedEventCount })
  const seq = token?.replySeq ?? reply.latest?.seq
  if (seq === undefined) return reply
  const original = snapshot.find((e) => e.seq === seq && e.type === 'assistant/message')
  if (!original) return failure('reply-unavailable')
  if (token && !snapshot.some((e) => e.seq === boundary)) return failure('snapshot-unavailable')
  const full = collectReply({ events: [original], afterSeq: seq - 1, maxChars: Infinity }).latest
  if (!full || (token && digest(full.text) !== token.hash)) return failure('reply-changed')
  // The same saved snapshot must still resolve to this reply, including admission facts.
  if (reply.latest?.seq !== seq) return failure('reply-changed')
  const start = token?.offset ?? 0
  const edges = boundaries(full.text)
  if (start >= full.chars || !edges.includes(start)) return failure('invalid-cursor')
  const end = edges.findLast((n) => n > start && n <= start + REPLY_TEXT_MAX)
  const more = end < full.chars
  const nextCursor = more ? encode({
    v: 1, workspaceId, sessionId, replySeq: seq, snapshotSeq: boundary,
    afterSeq: reply.afterSeq, offset: end, hash: digest(full.text),
    ...(deliveryMessageId === undefined ? {} : { deliveryMessageId }),
  }) : null
  return {
    ...reply,
    latest: { ...full, text: full.text.slice(start, end), truncated: more || start > 0 },
    page: { start, end, total: full.chars, more, nextCursor, snapshotSeq: boundary },
  }
}
