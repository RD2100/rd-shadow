import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { summarizeEvent } from '../lib/core-render.js'
import { pageReply } from '../lib/core-reply-page.js'
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
check('TC-REPLY-007', 'pages reconstruct Chinese, emoji, combining text and whitespace exactly', () => {
  const text = '  中文😀e\u0301👨‍👩‍👧‍👦\n'.repeat(1500) + ' END  '
  const events = [answer(1, 1, text)]
  const args = { events, workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: 0 }
  let page = pageReply(args)
  let joined = ''
  do {
    assert.ok(page.latest.text.length <= 8000)
    assert.ok(!page.latest.text.endsWith('\ud83d'))
    joined += page.latest.text
    page = page.page.nextCursor ? pageReply({ ...args, cursor: page.page.nextCursor }) : null
  } while (page)
  assert.equal(joined, text)
})
check('TC-REPLY-008', 'a cursor pins the original reply despite newer answers', () => {
  const events = [answer(1, 1, 'A'.repeat(9000))]
  const args = { events, workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: 0 }
  const first = pageReply(args)
  events.push(answer(2, 2, 'new'))
  const next = pageReply({ ...args, snapshotSeq: 2, cursor: first.page.nextCursor })
  assert.equal(next.latest.text, 'A'.repeat(1000))
  assert.equal(next.page.snapshotSeq, 1)
})
check('TC-REPLY-009', 'bad, wrong-target, changed, removed and rolled-back cursors refuse explicitly', () => {
  const events = [answer(1, 1, 'x'.repeat(9000))]
  const args = { events, workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: 0 }
  const cursor = pageReply(args).page.nextCursor
  assert.equal(pageReply({ ...args, cursor: 'bad' }).pageError, 'invalid-cursor')
  assert.equal(pageReply({ ...args, sessionId: 'other', cursor }).pageError, 'wrong-target')
  assert.equal(pageReply({ ...args, snapshotSeq: 0, cursor }).pageError, 'snapshot-unavailable')
  assert.equal(pageReply({ ...args, events: [], cursor }).pageError, 'reply-unavailable')
  assert.equal(pageReply({ ...args, events: [answer(1, 1, 'y'.repeat(9000))], cursor }).pageError, 'reply-changed')
  const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString())
  for (const offset of [-1, 9001, 1.5]) {
    const forged = Buffer.from(JSON.stringify({ ...raw, offset })).toString('base64url')
    assert.equal(pageReply({ ...args, cursor: forged }).pageError, 'invalid-cursor')
  }
})
check('TC-REPLY-010', 'empty and exact-boundary replies are bounded and hide reasoning', () => {
  const args = { workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: 0 }
  assert.equal(pageReply({ ...args, events: [answer(1, 1, '')] }).latest, null)
  const event = answer(1, 1, 'a'.repeat(8000))
  event.data.message.content.push({ type: 'reasoning', text: 'SECRET' })
  const r = pageReply({ ...args, events: [event] })
  assert.equal(r.page.more, false)
  assert.equal(r.page.nextCursor, null)
  assert.equal(r.latest.text.length, 8000)
})
check('TC-REPLY-011', 'page edges do not split emoji or combining marks; giant clusters remain bounded', () => {
  const args = { workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: 0 }
  for (const tail of ['😀', 'e\u0301', '👨‍👩‍👧‍👦']) {
    const events = [answer(1, 1, 'x'.repeat(7999) + tail + 'z')]
    const first = pageReply({ ...args, events })
    assert.equal(first.latest.text, 'x'.repeat(7999))
    const next = pageReply({ ...args, events, cursor: first.page.nextCursor })
    assert.equal(next.latest.text, tail + 'z')
    const token = JSON.parse(Buffer.from(first.page.nextCursor, 'base64url').toString())
    const cursor = Buffer.from(JSON.stringify({ ...token, offset: 8000 })).toString('base64url')
    assert.equal(pageReply({ ...args, events, cursor }).pageError, 'invalid-cursor')
  }
  const text = 'e' + '\u0301'.repeat(16000)
  const events = [answer(1, 1, text)]
  let cursor, joined = ''
  do {
    const page = pageReply({ ...args, events, cursor })
    assert.ok(page.latest.text.length <= 8000)
    joined += page.latest.text
    cursor = page.page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(joined, text)
})
check('TC-REPLY-012', 'legacy negative sequence values always generate usable cursors', () => {
  const args = { events: [answer(1, 1, 'a'.repeat(9000))], workspaceId: 'w', sessionId: 's', snapshotSeq: 1, afterSeq: -2 }
  const first = pageReply(args)
  assert.equal(pageReply({ ...args, cursor: first.page.nextCursor }).latest.text, 'a'.repeat(1000))
})
check('TC-REPLY-013', 'event summaries remove private reasoning and raw stream data', () => {
  const e = answer(1, 1, 'public')
  e.data.message.content.unshift({ type: 'reasoning', text: 'PRIVATE_REASONING' })
  e.data.stream = ['PRIVATE_STREAM']
  assert.ok(!summarizeEvent(e).includes('PRIVATE'))
  assert.ok(!summarizeEvent(event(2, 'assistant/attempt', { stream: 'PRIVATE_ATTEMPT' })).includes('PRIVATE'))
})
await done()
