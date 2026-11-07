/**
 * Self-check for lib/dispatch-core.js. Runs under plain Node with no host
 * services: builds synthetic session logs and asserts the ported judgment.
 */
import { renderTargets } from '../lib/core-render.js'
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import {
  REASON, DispatchCoreError, DISPATCH_TOOL,
  deriveIdentity, deriveMessageId, buildRelayMessage, findDispatchCall, argumentsMatch,
  currentSelection, foldInbox, pendingUserWait, deliveryEvidence,
  decideTargetState, isReceivable, selectionMismatch,
  renderSelection, renderDispatchReceipt, renderInspection, summarizeEvent,
  collectReply, UNTRUSTED_LINE,
} from '../lib/dispatch-core.js'

const { check, todo, done } = suite('dispatch-core')

/* ---------- identity ---------- */
check('TC-CORE-001', 'identity is stable for the same call', () => {
  assert.equal(deriveIdentity({ sessionId: 's', callId: 'c', kind: 'direct' }), deriveIdentity({ sessionId: 's', callId: 'c', kind: 'direct' }))
})
check('TC-CORE-002', 'identity separates kind, call, and session', () => {
  const base = deriveIdentity({ sessionId: 's', callId: 'c', kind: 'direct' })
  assert.notEqual(base, deriveIdentity({ sessionId: 's', callId: 'c', kind: 'ptc' }))
  assert.notEqual(base, deriveIdentity({ sessionId: 's', callId: 'c2', kind: 'direct' }))
  assert.notEqual(base, deriveIdentity({ sessionId: 's2', callId: 'c', kind: 'direct' }))
})

/* ---------- messageId ---------- */
const baseFacts = {
  identity: 'id1', workspaceId: 'w', sessionId: 'target', senderSessionId: 'shadow',
  provider: 'p', model: 'm', content: 'hello',
}
check('TC-CORE-003', 'messageId is deterministic', () => {
  assert.equal(deriveMessageId(baseFacts), deriveMessageId(baseFacts))
  assert.match(deriveMessageId(baseFacts), /^shadow-message-[0-9a-f]{64}$/)
})
check('TC-CORE-004', 'messageId changes when the target changes', () => {
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, sessionId: 'other' }))
})
check('TC-CORE-005', 'messageId changes when the content or model changes', () => {
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, content: 'hello!' }))
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, model: 'm2' }))
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, reasoningEffort: 'high' }))
})
check('TC-CORE-006', 'messageId normalizes an empty effort to absent', () => {
  assert.equal(deriveMessageId({ ...baseFacts, reasoningEffort: '' }), deriveMessageId(baseFacts))
})
check('TC-CORE-007', 'messageId refuses a missing fact', () => {
  assert.throws(() => deriveMessageId({ ...baseFacts, content: '' }), (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})

/* ---------- relay message ---------- */
check('TC-CORE-008', 'relay message is frozen and carries the sender', () => {
  const message = buildRelayMessage({ messageId: 'shadow-message-x', content: 'go', senderSessionId: 'shadow-1' })
  assert.equal(message.id, 'shadow-message-x')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'shadow-1' })
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content) && Object.isFrozen(message.content[0]) && Object.isFrozen(message.source))
})

/* ---------- call anchoring ---------- */
const callLog = [
  { type: 'assistant/message', seq: 3, data: { content: [{ type: 'tool-call', id: 'call-1', name: DISPATCH_TOOL, arguments: '{"workspaceId":"w","sessionId":"t","content":"go"}' }] } },
  { type: 'tool/call', seq: 4, data: { turn: 1, step: 0, callId: 'call-1', name: DISPATCH_TOOL, arguments: '{"workspaceId":"w","sessionId":"t","content":"go"}' } },
  { type: 'tool/ptc-dispatch-start', seq: 6, data: { rootCallId: 'call-1', parentCallId: 'call-1', subCallId: 'call-1:ptc:1', name: DISPATCH_TOOL, arguments: { workspaceId: 'w', sessionId: 't', content: 'go' } } },
]
check('TC-CORE-009', 'findDispatchCall finds the direct call', () => {
  assert.deepEqual(findDispatchCall({ events: callLog, callId: 'call-1' }), { kind: 'direct', arguments: '{"workspaceId":"w","sessionId":"t","content":"go"}' })
})
check('TC-CORE-010', 'findDispatchCall finds the ptc sub-call', () => {
  assert.deepEqual(findDispatchCall({ events: callLog, callId: 'call-1:ptc:1' }), { kind: 'ptc', arguments: { workspaceId: 'w', sessionId: 't', content: 'go' } })
})
check('TC-CORE-011', 'findDispatchCall ignores other tools and reports absence', () => {
  assert.equal(findDispatchCall({ events: callLog, callId: 'nope' }), null)
  assert.equal(findDispatchCall({ events: [{ type: 'tool/call', seq: 1, data: { callId: 'x', name: 'read', arguments: '{}' } }], callId: 'x' }), null)
})

/* ---------- arguments matching (rc.3 logs raw JSON strings for direct calls) ---------- */
check('TC-CORE-012', 'argumentsMatch: a raw JSON string matches its parsed object', () => {
  const raw = JSON.stringify({ workspaceId: 'w', sessionId: 't', content: 'go' })
  assert.equal(argumentsMatch(raw, { workspaceId: 'w', sessionId: 't', content: 'go' }), true)
  assert.equal(argumentsMatch(raw, { workspaceId: 'w', sessionId: 't', content: 'other' }), false)
})
check('TC-CORE-013', 'argumentsMatch: an object record matches directly (ptc form)', () => {
  assert.equal(argumentsMatch({ workspaceId: 'w' }, { workspaceId: 'w' }), true)
  assert.equal(argumentsMatch({ workspaceId: 'w' }, { workspaceId: 'x' }), false)
})
check('TC-CORE-014', 'argumentsMatch: unparseable text is compared as text', () => {
  assert.equal(argumentsMatch('{not json', '{not json'), true)
  assert.equal(argumentsMatch('{not json', {}), false)
})
check('TC-CORE-015', 'argumentsMatch: an empty record matches the parser default', () => {
  assert.equal(argumentsMatch('', {}), true)
  assert.equal(argumentsMatch('{}', {}), true)
})

/* ---------- current selection ---------- */
check('TC-CORE-016', 'selection: pending intent wins', () => {
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p1', model: 'm1' } } } },
    { type: 'model/selection', seq: 2, data: { provider: 'p2', model: 'm2', reasoningEffort: 'high' } },
  ]
  assert.deepEqual(currentSelection(events), { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
})
check('TC-CORE-017', 'selection: a consuming request header retires the intent', () => {
  const events = [
    { type: 'model/selection', seq: 1, data: { provider: 'p2', model: 'm2' } },
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p2', model: 'm2' } } } },
    { type: 'request/header', seq: 3, data: { header: { config: { provider: 'p3', model: 'm3' } } } },
  ]
  assert.deepEqual(currentSelection(events), { provider: 'p3', model: 'm3' })
})
check('TC-CORE-018', 'selection: falls back to the last request header', () => {
  const events = [{ type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } } } }]
  assert.deepEqual(currentSelection(events), { provider: 'p', model: 'm', reasoningEffort: 'low' })
})
check('TC-CORE-019', 'selection: null when the log records none', () => {
  assert.equal(currentSelection([{ type: 'user/message', seq: 1, data: {} }]), null)
  assert.equal(currentSelection([]), null)
})

/* ---------- inbox fold ---------- */
check('TC-CORE-020', 'inbox: splices apply in order', () => {
  const events = [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'a' }, { id: 'b' }] } },
    { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-step', start: 0, inserted: [{ id: 'c' }] } },
  ]
  const state = foldInbox(events)
  assert.deepEqual(state['next-turn'].map((m) => m.id), ['b'])
  assert.deepEqual(state['next-step'].map((m) => m.id), ['c'])
})
check('TC-CORE-021', 'inbox: an invalid splice fails loud as unknown', () => {
  assert.throws(() => foldInbox([{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 5, inserted: [] } }]),
    (error) => error instanceof DispatchCoreError && error.code === REASON.unknown)
})

/* ---------- waiting-user ---------- */
check('TC-CORE-022', 'waiting-user: an open question blocks', () => {
  assert.equal(pendingUserWait([{ type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'ask_user_question', arguments: {} } }]), true)
})
check('TC-CORE-023', 'waiting-user: a result releases the question', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'ask_user_question', arguments: {} } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'q1', content: [], isError: false } } },
  ]
  assert.equal(pendingUserWait(events), false)
})
check('TC-CORE-024', 'waiting-user: an undecided approval blocks', () => {
  const events = [
    { type: 'approval/asked', seq: 1, data: { id: 'a1', toolName: 'x' } },
  ]
  assert.equal(pendingUserWait(events), true)
  events.push({ type: 'approval/decided', seq: 2, data: { id: 'a1', outcome: 'allowed-once' } })
  assert.equal(pendingUserWait(events), false)
})

/* ---------- delivery evidence ---------- */
const targetMessage = buildRelayMessage({ messageId: 'shadow-message-x', content: 'go', senderSessionId: 'shadow-1' })
function evidenceLog(extra = []) {
  return [
    { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, inserted: [targetMessage] } },
    { type: 'user/message', seq: 3, data: targetMessage },
    { type: 'request/header', seq: 4, data: { header: { config: { provider: 'p', model: 'm' } } } },
    ...extra,
  ]
}
check('TC-CORE-025', 'evidence: records the admitted request', () => {
  const evidence = deliveryEvidence({ events: evidenceLog([{ type: 'assistant/message', seq: 5, data: {} }]), inheritedEventCount: 0, message: targetMessage })
  assert.deepEqual(evidence, {
    inboxSeq: 2, userSeq: 3,
    execution: { selection: { provider: 'p', model: 'm' }, requestHeaderSeq: 4, settled: true },
  })
})
check('TC-CORE-026', 'evidence: unsettled when the turn ends before any assistant output', () => {
  const evidence = deliveryEvidence({ events: evidenceLog([{ type: 'step/end', seq: 5, data: {} }]), inheritedEventCount: 0, message: targetMessage })
  assert.deepEqual(evidence.execution, { selection: { provider: 'p', model: 'm' }, requestHeaderSeq: 4, settled: false })
})
check('TC-CORE-027', 'evidence: null when the message never entered', () => {
  assert.equal(deliveryEvidence({ events: [{ type: 'user/message', seq: 1, data: { id: 'other' } }], inheritedEventCount: 0, message: targetMessage }), null)
})
check('TC-CORE-028', 'evidence: inherited splices do not count as this session delivery', () => {
  const events = [{ type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-turn', start: 0, inserted: [targetMessage] } }]
  assert.equal(deliveryEvidence({ events, inheritedEventCount: 1, message: targetMessage }), null)
})
check('TC-CORE-029', 'evidence: same id with different content fails loud', () => {
  const forged = { ...targetMessage, content: [{ type: 'text', text: 'tampered' }] }
  const events = [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [forged] } }]
  assert.throws(() => deliveryEvidence({ events, inheritedEventCount: 0, message: targetMessage }),
    (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})
check('TC-CORE-030', 'evidence: a surfaced message with a different source fails loud', () => {
  const events = [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [targetMessage] } },
    { type: 'user/message', seq: 2, data: { ...targetMessage, source: { kind: 'user-rpc' } } }]
  assert.throws(() => deliveryEvidence({ events, inheritedEventCount: 0, message: targetMessage }),
    (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})

/* ---------- target state ---------- */
check('TC-CORE-031', 'state: cold, busy, waiting, pending, archived, subagent, unknown', () => {
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false }), 'cold')
  assert.equal(decideTargetState({ live: true, status: 'running', archived: false, subagent: false, waitingUser: false, inboxPending: false }), REASON.busy)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: false, waitingUser: true, inboxPending: false }), REASON.waitingUser)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: false, waitingUser: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: true, subagent: false }), REASON.archived)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: true }), REASON.subagent)
  assert.equal(decideTargetState({ live: false, archived: true, subagent: false }), REASON.archived)
  assert.equal(decideTargetState({ live: true, readFailed: true }), REASON.unknown)
})
check('TC-CORE-032', 'state: durable blockers outrank liveness', () => {
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false, waitingUser: true }), REASON.waitingUser)
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: true, status: 'running', archived: false, subagent: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: false, status: 'running', archived: false, subagent: false }), REASON.cold)
})
check('TC-CORE-033', 'state: only idle and cold are receivable', () => {
  assert.equal(isReceivable('idle'), true)
  assert.equal(isReceivable('cold'), true)
  for (const state of [REASON.busy, REASON.archived, REASON.waitingUser, REASON.pending, REASON.subagent, REASON.unknown]) {
    assert.equal(isReceivable(state), false, state)
  }
})

/* ---------- selection mismatch ---------- */
check('TC-CORE-034', 'mismatch: compares the fields a request runs with', () => {
  assert.equal(selectionMismatch({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), false)
  assert.equal(selectionMismatch({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), true)
  assert.equal(selectionMismatch(null, { provider: 'p', model: 'm' }), true)
})

/* ---------- rendering ---------- */
check('TC-CORE-035', 'render: selection formats', () => {
  assert.equal(renderSelection(null), '(unchanged)')
  assert.equal(renderSelection({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(renderSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m/high')
})
check('TC-CORE-036', 'render: receipt carries the pinned labels', () => {
  const text = renderDispatchReceipt({
    status: 'durable', target: 'w/t', messageId: 'shadow-message-x',
    selected: { provider: 'p', model: 'm' },
    evidence: { inboxSeq: 2, userSeq: 3, execution: { selection: { provider: 'p', model: 'm' }, requestHeaderSeq: 4, settled: true } },
  })
  assert.match(text, /^shadow_dispatch -> durable\n/)
  assert.match(text, /target: w\/t\n/)
  assert.match(text, /message: shadow-message-x\n/)
  assert.match(text, /selected: p\/m\n/)
  assert.match(text, /evidence: inbox@2 user@3 execution@4 settled=true$/)
  assert.doesNotMatch(text, /reason:/)
})
check('TC-CORE-037', 'render: unknown forbids the same-arguments retry', () => {
  const text = renderDispatchReceipt({ status: 'unknown', target: 'w/t', selected: null, evidence: null, reason: 'lost confirmation after send' })
  assert.match(text, /shadow_dispatch -> unknown/)
  assert.match(text, /reason: lost confirmation after send/)
  assert.match(text, /do not retry with the same arguments/)
})
check('TC-CORE-038', 'render: mismatch is reported without a silent switch-back', () => {
  const text = renderDispatchReceipt({
    status: 'durable', selected: { provider: 'p', model: 'm' }, executedSelection: { provider: 'p', model: 'm2' },
    evidence: { inboxSeq: 1, userSeq: 2, execution: null }, modelMismatch: true,
  })
  assert.match(text, /mismatch: the target ran p\/m2; it was not switched back/)
})
check('TC-CORE-039', 'render: inspection shows state, model, and the event page', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\proj', model: { provider: 'p', model: 'm' }, asOfSeq: 9,
    events: [summarizeEvent({ type: 'user/message', seq: 8, data: { id: 'x' } })],
  })
  assert.match(text, /^shadow_inspect -> idle\n/)
  assert.match(text, /model: p\/m\n/)
  assert.match(text, /asOfSeq: 9\n/)
  assert.match(text, /events \(1\):\n#8 user\/message /)
})
check('TC-CORE-040', 'render: a paged inspection says how much is left and where the end is', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\p', model: null, asOfSeq: 90,
    events: ['#11 a', '#12 b'],
    eventPage: { total: 40, afterSeq: 10, lastSeq: 90, limit: 2 },
  })
  assert.match(text, /events \(2 of 40 after seq 10; last seq is 90\):/)
  assert.match(text, /\(38 more: raise limit, or jump near the end with afterSeq 88\)/)
})
check('TC-CORE-041', 'render: a complete page needs no "more" line', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\p', model: null, asOfSeq: 12,
    events: ['#11 a', '#12 b'],
    eventPage: { total: 2, afterSeq: 10, lastSeq: 12, limit: 20 },
  })
  assert.match(text, /events \(2 of 2 after seq 10; last seq is 12\):/)
  assert.doesNotMatch(text, /more:/)
})
check('TC-CORE-042', 'render: a refusal before the read omits the probe lines', () => {
  const text = renderInspection({ state: REASON.sessionNotFound, target: 'w/t', reason: 'no Session "t" exists' })
  assert.match(text, /^shadow_inspect -> session-not-found\n/)
  assert.doesNotMatch(text, /cwd:/)
  assert.doesNotMatch(text, /model:/)
  assert.doesNotMatch(text, /asOfSeq:/)
})
check('TC-CORE-043', 'render: inspection reports an unreadable target with its reason', () => {
  const text = renderInspection({ state: REASON.unknown, target: 'w/t', model: null, asOfSeq: -1, reason: 'session has no readable log' })
  assert.match(text, /shadow_inspect -> unknown/)
  assert.match(text, /reason: session has no readable log/)
})
check('TC-CORE-044', 'render: a long event summary is bounded', () => {
  const line = summarizeEvent({ type: 'tool/result', seq: 1, data: { blob: 'x'.repeat(5000) } })
  assert.ok(line.length < 260, `summary too long: ${line.length}`)
})

check('TC-CORE-045', 'renderTargets prints the titles-unavailable line only when asked (TASK-02)', () => {
  assert.equal(renderTargets({ workspaces: [], titlesUnavailable: 'x' }).split('\n')[1], 'titles: unavailable (x)')
  assert.ok(!renderTargets({ workspaces: [] }).includes('titles:'))
})
check('TC-CORE-046', 'an inspection event page is introduced by the untrusted-data line (TASK-03)', () => {
  const lines = renderInspection({ state: 'idle', target: 'w/t', probed: true, asOfSeq: 1, events: ['#1 x {}'], eventPage: { total: 1, afterSeq: 0, lastSeq: 1, limit: 20 } }).split('\n')
  const marker = lines.indexOf(UNTRUSTED_LINE)
  const page = lines.findIndex((line) => line.startsWith('events ('))
  assert.ok(marker >= 0 && marker === page - 1, lines.join('\n'))
  const bare = renderInspection({ state: 'idle', target: 'w/t', probed: true, asOfSeq: 1 })
  assert.doesNotMatch(bare, /^untrusted:/m)
})

/* ---------- reply (ADR-012) ---------- */
const replyLog = [
  { seq: 5, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [] } },
  { seq: 6, type: 'user/message', data: { id: 'u1' } },
  { seq: 7, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'tool-call', id: 't', name: 'pwsh', arguments: '{}' }, { type: 'text', text: 'checking' }] } } },
  { seq: 8, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done:' }, { type: 'text', text: 'tests pass' }] } } },
  { seq: 9, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]
check('TC-CORE-047', 'reply: the latest visible text wins; reasoning is hidden; tool calls are counted', () => {
  const reply = collectReply({ events: replyLog, afterSeq: 5 })
  assert.equal(reply.messages, 2)
  assert.equal(reply.toolCalls, 1)
  assert.equal(reply.turnsEnded, 1)
  assert.deepEqual(reply.lastTurnEnd, { seq: 9, kind: 'completed' })
  assert.deepEqual(reply.latest, { seq: 8, text: 'done:\ntests pass', chars: 16, truncated: false, interrupted: false })
})
check('TC-CORE-048', 'reply: events at or before afterSeq are ignored', () => {
  const after8 = collectReply({ events: replyLog, afterSeq: 8 })
  assert.equal(after8.messages, 0)
  assert.equal(after8.latest, null)
  assert.deepEqual(after8.lastTurnEnd, { seq: 9, kind: 'completed' })
  const after9 = collectReply({ events: replyLog, afterSeq: 9 })
  assert.deepEqual([after9.messages, after9.turnsEnded, after9.lastTurnEnd, after9.latest], [0, 0, null, null])
})
check('TC-CORE-049', 'reply: long text is cut to maxChars; interrupted and errored turns are reported', () => {
  const events = [
    { seq: 1, type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: 'x'.repeat(50) }] } } },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'quota exceeded', code: 'QUOTA' } } } },
  ]
  const reply = collectReply({ events, afterSeq: 0, maxChars: 10 })
  assert.deepEqual(reply.latest, { seq: 1, text: 'x'.repeat(10), chars: 50, truncated: true, interrupted: true })
  assert.deepEqual(reply.lastTurnEnd, { seq: 2, kind: 'error', error: 'quota exceeded' })
})
check('TC-CORE-050', 'render: a reply block is marked untrusted, summarized, and ends with the text', () => {
  const text = renderInspection({ state: 'idle', target: 'w/t', probed: true, asOfSeq: 9, reply: { afterSeq: 5, ...collectReply({ events: replyLog, afterSeq: 5 }) } })
  assert.ok(text.includes(`${UNTRUSTED_LINE}\nreply after seq 5: 2 assistant messages, 1 tool calls, 1 turns ended; last turn ended completed at seq 9\nreply text (seq 8; 16 chars):\ndone:\ntests pass`), text)
  assert.ok(text.endsWith('tests pass'))
})
check('TC-CORE-051', 'render: truncation, interruption, an errored turn, and an empty reply are spelled out', () => {
  const cut = renderInspection({ state: 'idle', target: 'w/t', reply: { afterSeq: 0, messages: 1, toolCalls: 0, turnsEnded: 1, lastTurnEnd: { seq: 2, kind: 'error', error: 'quota exceeded' }, latest: { seq: 1, text: 'xx', chars: 50, truncated: true, interrupted: true } } })
  assert.match(cut, /last turn ended error at seq 2 \(quota exceeded\)/)
  assert.match(cut, /reply text \(seq 1; 50 chars; truncated to the first 2; interrupted\):\nxx$/)
  const empty = renderInspection({ state: 'busy', target: 'w/t', reply: { afterSeq: 3, messages: 0, toolCalls: 0, turnsEnded: 0, lastTurnEnd: null, latest: null } })
  assert.match(empty, /last turn not ended \(the target may still be working\)\nreply text: \(none yet\)$/)
})
await done()
