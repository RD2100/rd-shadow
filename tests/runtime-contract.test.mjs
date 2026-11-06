/**
 * Runtime contract checks (ADR-013): the shapes this plugin reads, pinned
 * against the dsh 0.2.1-rc.3 event forms observed in real session logs
 * (field names and types only; texts here are placeholders).
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { VERIFIED_RUNTIME } from '../lib/core-contract.js'
import { collectReply } from '../lib/core-reply.js'
import { foldInbox, deliveryEvidence, currentSelection } from '../lib/core-log.js'
import { eventProblems, hostServiceProblems, leaseProblems, toolServiceProblems } from '../lib/core-shape.js'
import { decodeFrames, probeLog } from '../scripts/contract-probe.mjs'

const { check, done } = suite('runtime-contract')

/** One relay message exactly as shadow_dispatch builds it. */
const relay = { id: 'shadow-message-1', role: 'user', content: [{ type: 'text', text: 'run tests' }], source: { kind: 'agent-message', form: 'relay', senderSessionId: 'shadow-1' } }

/** One event of each folded type, in the rc.3 shapes (seq/time/data envelope). */
const rc3 = [
  { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'danger-full-access' } },
  { type: 'sandbox/mode', seq: 1, time: 0, data: { mode: 'workspace-write' } },
  { type: 'agent/inbox/spliced', seq: 2, time: 0, data: { target: 'next-turn', start: 0, inserted: [relay] } },
  { type: 'agent/inbox/spliced', seq: 3, time: 0, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  { type: 'user/message', seq: 4, time: 0, surfaceOp: 'append', data: relay },
  { type: 'request/header', seq: 5, time: 0, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'high' }, tools: [] }, reason: 'series' } },
  { type: 'assistant/message', seq: 6, time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'reasoning', text: 'r' }, { type: 'tool-call', id: 'c', name: 'pwsh', arguments: '{}' }] }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, stream: [] } },
  { type: 'tool/call', seq: 7, time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'pwsh', arguments: '{}' } },
  { type: 'step/end', seq: 8, time: 0, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 9, time: 0, surfaceOp: 'append', data: { turn: 1, step: 2, message: { role: 'assistant', id: 'a2', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } } },
  { type: 'turn/end', seq: 10, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/end', seq: 11, time: 0, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  { type: 'turn/end', seq: 12, time: 0, data: { turn: 3, reason: { kind: 'error', error: { message: 'm', code: 'C' } } } },
]

check('TC-RTC-001', 'every rc.3 event shape passes the check and folds as expected', () => {
  assert.deepEqual(eventProblems(rc3), [])
  assert.deepEqual(foldInbox(rc3)['next-turn'], [])
  assert.deepEqual(currentSelection(rc3), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  const evidence = deliveryEvidence({ events: rc3, inheritedEventCount: 0, message: relay })
  assert.deepEqual([evidence.inboxSeq, evidence.userSeq, evidence.execution?.requestHeaderSeq], [2, 4, 5])
  const reply = collectReply({ events: rc3, afterSeq: 2 })
  assert.deepEqual([reply.messages, reply.toolCalls, reply.turnsEnded, reply.latest?.text, reply.lastTurnEnd?.kind], [2, 1, 3, 'ok', 'error'])
})

check('TC-RTC-002', 'each folded field that drifts is named with its seq and type', () => {
  const cases = [
    [{ type: 'agent/inbox/spliced', seq: 1, data: { queue: 'next-turn', start: 0, inserted: [] } }, '#1 agent/inbox/spliced: data.target is not a string'],
    [{ type: 'user/message', seq: 2, data: { message: { id: 'x' } } }, '#2 user/message: data.id is not a string'],
    [{ type: 'request/header', seq: 3, data: { config: {} } }, '#3 request/header: data.header.config is not an object'],
    [{ type: 'tool/call', seq: 4, data: { id: 'c', name: 'x' } }, '#4 tool/call: data.callId is not a string'],
    [{ type: 'assistant/message', seq: 5, data: { content: [] } }, '#5 assistant/message: data.message.content is not an array'],
    [{ type: 'turn/end', seq: 6, data: { reason: 'completed' } }, '#6 turn/end: data.reason.kind is not a string'],
  ]
  for (const [event, problem] of cases) assert.deepEqual(eventProblems([event]), [problem])
})

check('TC-RTC-003', 'unknown event types are ignored; a broken envelope is reported; reports are capped at 5', () => {
  assert.deepEqual(eventProblems([{ type: 'some/new-event', seq: 1, data: null }]), [])
  assert.deepEqual(eventProblems([{ kind: 'x', seq: 1 }]), ['an event has no string type or integer seq'])
  const many = Array.from({ length: 20 }, (_, seq) => ({ type: 'user/message', seq, data: {} }))
  assert.equal(eventProblems(many).length, 5)
})

check('TC-RTC-004', 'a session lease must carry iterable events, an integer cursor, a header, and an inherited count', () => {
  assert.deepEqual(leaseProblems({ events: [], cursor: -1, header: {}, inheritedEventCount: 0 }), [])
  assert.deepEqual(leaseProblems(null), ['the session lease is not an object'])
  assert.deepEqual(leaseProblems({ events: 3, cursor: '7', header: null, inheritedEventCount: -1 }), [
    'lease.events is not iterable',
    'lease.cursor is not an integer',
    'lease.header is not an object',
    'lease.inheritedEventCount is not a non-negative integer',
  ])
})

check('TC-RTC-005', 'service shapes name the missing service or method', () => {
  const fn = () => {}
  const tools = {
    agents: { get: fn },
    llm: { resolveModelInfo: fn },
    sessionController: { resolveAgent: fn, selectModel: fn },
    sessionQuery: { observeSession: fn, listSessions: fn, readTitleSnapshots: fn },
    workspaceRegistry: { get: fn, list: fn, archivedSessionIds: [] },
  }
  assert.deepEqual(toolServiceProblems(tools), [])
  assert.deepEqual(toolServiceProblems({ ...tools, llm: undefined }), ['llm is missing'])
  assert.deepEqual(toolServiceProblems({ ...tools, workspaceRegistry: { get: fn, list: fn, archivedSessionIds: new Set() } }), ['workspaceRegistry.archivedSessionIds is not an array'])
  assert.deepEqual(hostServiceProblems({ permissionPresets: { current: fn, set: fn }, sessions: { list: fn } }), [])
  assert.deepEqual(hostServiceProblems({ permissionPresets: { current: fn }, sessions: { list: fn } }), ['permissionPresets.set is not a function'])
})

check('TC-RTC-006', 'package.json engines.dsh starts at the verified runtime and stops before the next patch line', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.engines?.dsh, `>=${VERIFIED_RUNTIME} <0.2.2-0`)
})

check('TC-RTC-007', 'the probe decodes concatenated zstd frames and reports drift without message text', () => {
  const header = `${JSON.stringify({ type: 'header', id: 's' })}\n`
  const good = rc3.map((event) => `${JSON.stringify(event)}\n`).join('')
  const raw = Buffer.concat([zlib.zstdCompressSync(Buffer.from(header)), zlib.zstdCompressSync(Buffer.from(good))])
  const ok = probeLog(decodeFrames(raw))
  assert.deepEqual(ok, { events: rc3.length, problems: [], replyChars: 2 })
  const drifted = probeLog(`${header}${JSON.stringify({ type: 'turn/end', seq: 1, data: { reason: 'done' } })}\n`)
  assert.deepEqual(drifted.problems, ['#1 turn/end: data.reason.kind is not a string'])
})

await done()
