import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { collectReply } from '../lib/core-reply.js'
import { collectDeliveryReply } from '../lib/core-delivery.js'

const { check, done } = suite('reply')
const relay = { id: 'shadow-message-a', role: 'user', content: [{ type: 'text', text: 'job a' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'shadow' } }
const event = (seq, type, data) => ({ seq, type, data })
const answer = (seq, turn, text) => event(seq, 'assistant/message', { turn, message: { content: [{ type: 'text', text }] } })
const start = (seq, turn) => event(seq, 'turn/start', { turn })
const end = (seq, turn, kind = 'completed') => event(seq, 'turn/end', { turn, reason: { kind } })
const inbox = event(0, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [relay] })
const user = event(2, 'user/message', relay)
const log = [inbox, start(1, 1), user, answer(3, 1, 'A'), end(4, 1), start(5, 2), event(6, 'user/message', { id: 'b', source: { kind: 'user' } }), answer(7, 2, 'B'), end(8, 2)]
const read = (events, extra = {}) => collectDeliveryReply({ events, messageId: relay.id, inheritedEventCount: 0, ...extra })

check('TC-REPLY-001', 'delivery reply is confined to its own admitted turn', () => {
  const r = read(log)
  assert.equal(r.delivery.status, 'associated')
  assert.equal(r.latest.text, 'A')
  assert.equal(r.lastTurnEnd.seq, 4)
})
check('TC-REPLY-002', 'missing, pending, inherited and unbounded admissions stay uncertain', () => {
  assert.equal(read([]).delivery.status, 'not-found')
  assert.equal(read([inbox]).delivery.status, 'pending')
  assert.equal(read(log, { inheritedEventCount: 1 }).delivery.status, 'not-found')
  assert.equal(read([inbox, user, answer(3, 1, 'guess')]).delivery.status, 'uncertain')
})
check('TC-REPLY-003', 'multiple inputs share a turn; runtime context alone does not', () => {
  const input = event(3, 'user/message', { id: 'b', source: { kind: 'user' } })
  assert.equal(read([inbox, start(1, 1), user, input, answer(4, 1, 'both'), end(5, 1)]).delivery.status, 'shared')
  input.data.source.kind = 'runtime-context'
  assert.equal(read([inbox, start(1, 1), user, input, answer(4, 1, 'A')]).delivery.status, 'associated')
})
check('TC-REPLY-004', 'mismatched content, duplicate admission and missing end never borrow later output', () => {
  const bad = structuredClone(user); bad.data.content = []
  assert.equal(read([inbox, start(1, 1), bad]).delivery.status, 'uncertain')
  assert.equal(read([...log, event(9, 'user/message', relay)]).delivery.status, 'uncertain')
  const r = read([inbox, start(1, 1), user, answer(3, 1, 'A'), start(4, 2), answer(5, 2, 'B')])
  assert.equal(r.delivery.status, 'uncertain')
  assert.equal(r.latest, null)
})
check('TC-REPLY-005', 'error, cancellation and ongoing execution are distinct facts', () => {
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens']) {
    assert.equal(read([inbox, start(1, 1), user, end(3, 1, kind)]).lastTurnEnd.kind, kind)
  }
  assert.equal(read([inbox, start(1, 1), user, answer(3, 1, 'still working')]).lastTurnEnd, null)
})
check('TC-REPLY-006', 'legacy latest reply never borrows an earlier turn end', () => {
  const r = collectReply({ events: [answer(1, 1, 'old'), end(2, 1), start(3, 2), answer(4, 2, 'new')], afterSeq: 0 })
  assert.equal(r.latest.text, 'new')
  assert.equal(r.lastTurnEnd, null)
})
await done()
