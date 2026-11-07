/** Pure delivery-to-turn correlation. Never equates execution with acceptance. */
import { isDeepStrictEqual } from 'node:util'
import { collectReply } from './core-reply.js'

/** Only locally recorded, exact relay admissions can anchor a reply. */
export function collectDeliveryReply({ events, messageId, inheritedEventCount = 0 }) {
  const own = events.filter((e) => e.seq >= inheritedEventCount)
  const empty = (status, detail) => ({
    afterSeq: -1, ...collectReply({ events: [], afterSeq: -1 }),
    delivery: { messageId, status, detail },
  })
  const inserted = own.filter((e) => e.type === 'agent/inbox/spliced')
    .flatMap((e) => (e.data.inserted ?? []).filter((m) => m?.id === messageId).map((message) => ({ message, seq: e.seq })))
  if (inserted.length === 0) return empty('not-found', 'no local inbox evidence for this message')
  const { message, seq: inboxSeq } = inserted[0]
  if (message.source?.kind !== 'agent-message' || message.source?.form !== 'relay'
    || inserted.some((i) => !isDeepStrictEqual(i.message, message))) return empty('uncertain', 'inbox identity conflict')
  const admitted = own.filter((e) => e.type === 'user/message' && e.data.id === messageId)
  if (admitted.length === 0) return empty('pending', 'received in inbox; no admission evidence yet')
  if (admitted.length !== 1) return empty('uncertain', 'multiple admissions of this message')
  const user = admitted[0]
  if (user.seq <= inboxSeq || !isDeepStrictEqual(user.data.content, message.content)
    || !isDeepStrictEqual(user.data.source, message.source)) return empty('uncertain', 'admission identity conflict')
  // A user/message carries no turn field in rc.3: use the surrounding boundaries.
  let boundary = null
  for (const e of own) {
    if (e.seq >= user.seq) break
    if (e.type === 'turn/start') boundary = e
    if (e.type === 'turn/end') boundary = null
  }
  if (boundary === null || !Number.isSafeInteger(boundary.data.turn)) return empty('uncertain', 'no enclosing turn/start')
  const turn = boundary.data.turn
  const range = []
  let ended = false
  for (const e of own) {
    if (e.seq <= boundary.seq) continue
    if (e.type === 'turn/start') {
      if (!ended) return empty('uncertain', 'next turn started without a matching end')
      break
    }
    if (ended) break
    if ((e.type === 'assistant/message' || e.type === 'turn/end') && e.data.turn !== turn) {
      return empty('uncertain', 'reply or end has no matching turn identity')
    }
    range.push(e)
    if (e.type === 'turn/end') ended = true
  }
  const inputs = range.filter((e) => e.type === 'user/message' && e.data.source?.kind !== 'runtime-context')
  return {
    afterSeq: user.seq,
    ...collectReply({ events: range, afterSeq: user.seq }),
    delivery: {
      messageId, inboxSeq, userSeq: user.seq, turn, startSeq: boundary.seq,
      status: inputs.length > 1 ? 'shared' : 'associated',
      detail: inputs.length > 1 ? 'multiple inputs share this turn; no exclusive attribution' : 'exact admission within this turn only',
    },
  }
}
