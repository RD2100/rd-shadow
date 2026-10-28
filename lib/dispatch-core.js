/**
 * Pure dispatch core for the shadow plugin.
 *
 * This module holds the judgment ported from the retired workbench's
 * session-control and orchestration layers: identity derivation, the
 * deterministic relay message, delivery-evidence scanning, target-state
 * admission, and receipt rendering. It deliberately has no dependency on any
 * host service — the agent-scoped tools entry (lib/tools.js) supplies the
 * effects (resolveAgent, selectModel, send) and maps this core's outcomes onto
 * tool results.
 *
 * Ported contracts, in the order a dispatch uses them:
 * - `findDispatchCall` anchors one communication to the durable tool call that
 *   produced it, so a replayed execution keeps its identity (workbench
 *   identity.ts: only the log, never the arguments as self-reported).
 * - `deriveMessageId` is the idempotency key. It covers coordinator, target,
 *   content, and selection, so changing the target is a new message and
 *   replaying one call is not (DESIGN §5.3).
 * - `deliveryEvidence` reads the target log without activating it, and reports
 *   the first model request that admitted the message (workbench evidence.ts).
 * - `decideTargetState` admits only a target that can receive right now.
 *
 * Failure rule carried over from DESIGN §5: no silent degradation. Every
 * rejection names a code; nothing here catches and continues.
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

/** Tool name whose calls this core anchors dispatch identities to. */
export const DISPATCH_TOOL = 'shadow_dispatch'

/** Prefix of every derived relay message id. */
const MESSAGE_ID_PREFIX = 'shadow-message-'

/** Maximum characters of one content part accepted from the model. */
export const CONTENT_MAX_LENGTH = 20000

/** Maximum events one inspection page returns. */
export const INSPECT_PAGE_MAX = 50

/** Maximum characters of one event summary inside an inspection page. */
const EVENT_SUMMARY_MAX = 200

/**
 * Stable rejection and outcome vocabulary. The tools entry renders these
 * verbatim so the model can act on them without host-internal prose.
 */
export const REASON = Object.freeze({
  notShadow: 'not-shadow',
  invalidContent: 'invalid-content',
  sessionNotFound: 'session-not-found',
  workspaceNotFound: 'workspace-not-found',
  workspaceMismatch: 'workspace-session-mismatch',
  identityConflict: 'identity-conflict',
  modelUnavailable: 'model-unavailable',
  sessionChanged: 'session-changed',
  sessionDetached: 'session-detached',
  idle: 'idle',
  cold: 'cold',
  busy: 'busy',
  archived: 'archived',
  waitingUser: 'waiting-user',
  pending: 'pending',
  subagent: 'subagent',
  unknown: 'unknown',
})

/** A core-level failure carrying one of the {@link REASON} codes. */
export class DispatchCoreError extends Error {
  /**
   * @param code - one stable vocabulary code.
   * @param message - human-readable cause for logs.
   */
  constructor(code, message) {
    super(message)
    this.name = 'DispatchCoreError'
    this.code = code
  }
}

/**
 * Hash a sequence of parts with an unambiguous separator.
 * @param parts - ordered strings; order is part of the digest.
 * @returns the lowercase hex SHA-256 digest.
 */
function digest(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part, 'utf8').update('\u0000', 'utf8')
  return hash.digest('hex')
}

/**
 * Derive the communication identity of one dispatch call.
 *
 * The identity survives a replay of the same model call (the same callId is
 * re-executed from the same durable block) and differs for a new call, which is
 * what makes `already-delivered` exact. The workbench derived the same
 * guarantee from the assistant block coordinates; the tool-call event carries
 * the equivalent coordinates directly.
 * @param facts - the shadow session id, the executing callId, and its kind.
 * @returns the hex identity digest.
 */
export function deriveIdentity({ sessionId, callId, kind }) {
  return digest([sessionId, callId, kind])
}

/**
 * Derive the idempotency key of one relay message.
 * @param facts - identity plus the delivery facts that make two deliveries distinct.
 * @returns the message id, or a {@link DispatchCoreError} for a missing fact.
 */
export function deriveMessageId(facts) {
  const required = ['identity', 'workspaceId', 'sessionId', 'senderSessionId', 'provider', 'model', 'content']
  for (const key of required) {
    if (typeof facts[key] !== 'string' || facts[key].length === 0) {
      throw new DispatchCoreError(REASON.identityConflict, `deriveMessageId: missing ${key}`)
    }
  }
  return MESSAGE_ID_PREFIX + digest([
    facts.identity,
    facts.workspaceId,
    facts.sessionId,
    facts.senderSessionId,
    facts.provider,
    facts.model,
    facts.reasoningEffort ?? '',
    facts.content,
  ])
}

/**
 * Freeze the relay message exactly as it will be recorded.
 *
 * The source records who sent it, so the target's log reconstructs the
 * delegation; the id is the idempotency key the target and the shadow agree on.
 * @param facts - message id, content, and sending session id.
 * @returns the immutable message.
 */
export function buildRelayMessage({ messageId, content, senderSessionId }) {
  return Object.freeze({
    id: messageId,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: content })]),
    source: Object.freeze({ kind: 'agent-message', form: 'relay', senderSessionId }),
  })
}

/**
 * Locate the durable call that is executing right now.
 *
 * A direct call appears as `tool/call`; a PTC sub-call appears as
 * `tool/ptc-dispatch-start` with its own subCallId. Absence means the call is
 * not in the log yet, which cannot happen inside `execute`.
 *
 * The recorded arguments are returned exactly as the log holds them: a direct
 * call keeps the model's raw JSON string, a PTC sub-call the normalized object.
 * Compare them with {@link argumentsMatch}, never directly.
 * @param facts - the target session's events, the executing callId, and the tool name.
 * @returns the recorded call kind and raw arguments, or null when absent.
 */
export function findDispatchCall({ events, callId, toolName = DISPATCH_TOOL }) {
  let ptc = null
  for (const event of events) {
    const data = event.data
    if (event.type === 'tool/call' && data?.name === toolName && data.callId === callId) {
      return { kind: 'direct', arguments: data.arguments }
    }
    if (event.type === 'tool/ptc-dispatch-start' && data?.name === toolName && data.subCallId === callId) {
      ptc = { kind: 'ptc', arguments: data.arguments }
    }
  }
  return ptc
}

/**
 * Whether a log-recorded call matches the arguments this execution received.
 *
 * The log stores a direct call's arguments as the model's raw JSON string
 * (`parseArguments` turns the same bytes into the execution's object), and a
 * PTC sub-call's arguments as an already-normalized object. The mirror is
 * exact: empty text parses to `{}`, and invalid JSON is preserved as text.
 * @param recorded - the arguments exactly as the log holds them.
 * @param supplied - the arguments this execution received.
 * @returns true when both describe the same call.
 */
export function argumentsMatch(recorded, supplied) {
  if (typeof recorded !== 'string') return isDeepStrictEqual(recorded, supplied)
  if (recorded.length === 0) return isDeepStrictEqual({}, supplied)
  try {
    return isDeepStrictEqual(JSON.parse(recorded), supplied)
  } catch {
    return isDeepStrictEqual(recorded, supplied)
  }
}

/**
 * Normalize one selection record from a log event.
 * @param config - provider, model, and optional reasoningEffort.
 * @returns the normalized selection, or null when unusable.
 */
function selectionOf(config) {
  if (typeof config?.provider !== 'string' || config.provider.length === 0) return null
  if (typeof config?.model !== 'string' || config.model.length === 0) return null
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined || config.reasoningEffort === null ? {} : { reasoningEffort: String(config.reasoningEffort) },
  }
}

/**
 * Fold the target's effective current model selection from its log.
 *
 * This mirrors the official modelSelection projection (`pending ?? lastUsed`)
 * without depending on projection registration, so one code path serves a cold
 * and a live target: a `model/selection` event is a pending intent until a
 * `request/header` consumes it.
 * @param events - the target session's events, oldest first.
 * @returns the effective selection, or null when the log records none.
 */
export function currentSelection(events) {
  let pending = null
  let lastUsed = null
  for (const event of events) {
    if (event.type === 'model/selection') pending = selectionOf(event.data)
    else if (event.type === 'request/header') {
      lastUsed = selectionOf(event.data?.header?.config)
      if (pending !== null && lastUsed !== null
        && pending.provider === lastUsed.provider && pending.model === lastUsed.model
        && pending.reasoningEffort === lastUsed.reasoningEffort) pending = null
    }
  }
  return pending ?? lastUsed
}

/**
 * Fold the durable inbox into its two pending queues.
 *
 * The splice record is `{target, start, removedCount?, inserted}` over the
 * official projection's queues; invalid history is log corruption and fails
 * loud rather than being read as "empty".
 * @param events - the target session's events, oldest first.
 * @returns the pending `next-turn` and `next-step` message lists.
 * @throws {@link DispatchCoreError} `unknown` when a splice does not apply.
 */
export function foldInbox(events) {
  const state = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = event.data
    const queue = state[splice?.target]
    if (queue === undefined) throw new DispatchCoreError(REASON.unknown, `inbox splice at seq ${event.seq} names no queue`)
    const start = splice.start
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(start) || start < 0 || start > queue.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > queue.length) {
      throw new DispatchCoreError(REASON.unknown, `invalid inbox splice at seq ${event.seq}`)
    }
    state[splice.target] = queue.toSpliced(start, removedCount, ...splice.inserted)
  }
  return state
}

/**
 * Whether the target still owes the user an answer or a decision.
 *
 * A pending `ask_user_question` is an open tool call with no result yet; a
 * pending approval is an `approval/asked` without its `approval/decided`. A
 * question whose result already arrived (answered, failed, or timed out and
 * continued) no longer blocks the agent.
 * @param events - the target session's events, oldest first.
 * @returns true when the target is waiting on the user.
 */
export function pendingUserWait(events) {
  const openQuestions = new Set()
  const askedApprovals = new Set()
  for (const event of events) {
    const data = event.data
    if (event.type === 'tool/call' && data?.name === 'ask_user_question' && typeof data.callId === 'string') {
      openQuestions.add(data.callId)
    } else if (event.type === 'tool/result') {
      const callId = data?.message?.toolCallId
      if (typeof callId === 'string') openQuestions.delete(callId)
    } else if (event.type === 'approval/asked') {
      if (typeof data?.id === 'string') askedApprovals.add(data.id)
    } else if (event.type === 'approval/decided') {
      askedApprovals.delete(data?.id)
    }
  }
  return openQuestions.size > 0 || askedApprovals.size > 0
}

/**
 * Locate one exact delivery and the first model request that admitted it.
 *
 * Direct port of the workbench's evidence scan: the inbox splice proves the
 * message entered, `user/message` proves it was surfaced, and the following
 * `request/header` records the selection the target actually ran. Identity or
 * content collisions fail loud — the same id carrying different bytes means a
 * broken log, never a reason to guess.
 * @param facts - the target events, its inherited-event count, and the frozen message.
 * @returns the evidence, or null when the message never entered the inbox.
 * @throws {@link DispatchCoreError} `identityConflict` on an id/content collision.
 */
export function deliveryEvidence({ events, inheritedEventCount, message }) {
  let inboxSeq
  let userSeq = null
  let header
  let execution = null
  for (const event of events) {
    if (event.type === 'request/header') {
      const selection = selectionOf(event.data?.header?.config)
      if (selection !== null) {
        header = { seq: event.seq, selection }
        if (userSeq !== null) execution = { selection: header.selection, requestHeaderSeq: header.seq, settled: false }
      }
    }
    if (event.seq < inheritedEventCount) continue
    if (event.type === 'agent/inbox/spliced') {
      for (const inserted of event.data?.inserted ?? []) {
        if (inserted?.id !== message.id) continue
        if (!isDeepStrictEqual(inserted, message)) {
          throw new DispatchCoreError(REASON.identityConflict, `message ${message.id} entered the inbox with different content at seq ${event.seq}`)
        }
        inboxSeq ??= event.seq
      }
    }
    if (event.type === 'user/message' && event.data?.id === message.id) {
      if (!isDeepStrictEqual(event.data.source, message.source) || !isDeepStrictEqual(event.data.content, message.content)) {
        throw new DispatchCoreError(REASON.identityConflict, `message ${message.id} was surfaced with different source or content at seq ${event.seq}`)
      }
      userSeq = event.seq
    }
    if (userSeq !== null && (event.type === 'assistant/message' || event.type === 'assistant/attempt')) {
      if (header !== undefined) execution = { selection: header.selection, requestHeaderSeq: header.seq, settled: true }
      break
    }
    if (userSeq !== null && (event.type === 'step/end' || event.type === 'turn/end')) break
  }
  return inboxSeq === undefined ? null : { inboxSeq, userSeq, execution }
}

/**
 * Decide whether a target can receive a dispatch right now.
 *
 * The facts come from the host wrapper (live registry plus a log read); the
 * decision itself is pure so every rejection is testable without a runtime.
 * Durable blockers outrank liveness: an archived Session is `archived`, not
 * `cold`, and a Session that already owes the user an answer or already holds
 * unprocessed input is `waiting-user`/`pending`, not `cold` — dispatching there
 * would queue this message behind work nobody has seen the outcome of yet.
 * @param facts - what the wrapper observed about the target.
 * @returns one stable state: cold, busy, waiting-user, pending, archived, subagent, or unknown.
 */
export function decideTargetState(facts) {
  if (facts.readFailed) return REASON.unknown
  if (facts.archived) return REASON.archived
  if (facts.subagent) return REASON.subagent
  if (facts.waitingUser) return REASON.waitingUser
  if (facts.inboxPending) return REASON.pending
  if (!facts.live) return REASON.cold
  if (facts.status === 'running') return REASON.busy
  return REASON.idle
}

/** Target states that admit a dispatch. */
const RECEIVABLE = new Set([REASON.idle, REASON.cold])

/**
 * Whether one state admits a dispatch.
 * @param state - a state from {@link decideTargetState}.
 * @returns true when a delivery may be attempted.
 */
export function isReceivable(state) {
  return RECEIVABLE.has(state)
}

/** Prefix every Session id carries. */
export const SESSION_ID_PREFIX = 'session-'

/**
 * Suggest the intended Session id when a bare identifier was transcribed.
 *
 * Session ids are `session-<uuid>`, and a model relaying one occasionally drops
 * the prefix. Rewriting the id silently would guess at the user's intent, so the
 * tools report the near miss instead and let the caller retry with the exact id.
 * @param sessionId - the identifier the caller supplied.
 * @param candidates - the ids that belong to the named workspace.
 * @returns the matching prefixed id, or undefined when the guess is not exact.
 */
export function sessionIdSuggestion(sessionId, candidates) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (sessionId.startsWith(SESSION_ID_PREFIX)) return undefined
  const candidate = SESSION_ID_PREFIX + sessionId
  return candidates.includes(candidate) ? candidate : undefined
}

/**
 * Whether two selections differ in any field the request would run with.
 * @param left - one selection, possibly null.
 * @param right - the other selection, possibly null.
 * @returns true when they are not the same selection.
 */
export function selectionMismatch(left, right) {
  if (left === right) return false
  if (left === null || right === null) return true
  return left.provider !== right.provider || left.model !== right.model || left.reasoningEffort !== right.reasoningEffort
}

/**
 * One bounded line summarizing a session event for an inspection page.
 * @param event - the event to summarize.
 * @returns `#<seq> <type> <truncated data>`.
 */
export function summarizeEvent(event) {
  let summary
  try {
    summary = JSON.stringify(event.data) ?? ''
  } catch {
    summary = '(unserializable)'
  }
  if (summary.length > EVENT_SUMMARY_MAX) summary = `${summary.slice(0, EVENT_SUMMARY_MAX)}…`
  return `#${event.seq} ${event.type} ${summary}`
}

/**
 * Render one selection for receipts and inspection output.
 * @param selection - the selection, or null when none applies.
 * @returns a stable `provider/model[/effort]` string.
 */
export function renderSelection(selection) {
  if (selection === null || selection === undefined) return '(unchanged)'
  return selection.reasoningEffort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model}/${selection.reasoningEffort}`
}

/**
 * Render the delivery receipt the model reads.
 *
 * The format is pinned so the model can act on it without parsing prose:
 * `unknown` explicitly forbids a same-arguments retry, because a retry would
 * derive a new message id and deliver twice.
 * @param receipt - status, selection, evidence, mismatch flag, and reason.
 * @returns the model-facing text.
 */
export function renderDispatchReceipt(receipt) {
  const lines = [`shadow_dispatch -> ${receipt.status}`]
  if (receipt.target !== undefined) lines.push(`target: ${receipt.target}`)
  if (receipt.messageId !== undefined) lines.push(`message: ${receipt.messageId}`)
  lines.push(`selected: ${renderSelection(receipt.selected)}`)
  if (receipt.evidence !== null && receipt.evidence !== undefined) {
    const { inboxSeq, userSeq, execution } = receipt.evidence
    const parts = [`inbox@${inboxSeq ?? '-'}`, `user@${userSeq ?? '-'}`]
    if (execution !== null && execution !== undefined) {
      parts.push(`execution@${execution.requestHeaderSeq}`)
      parts.push(`settled=${execution.settled}`)
    }
    lines.push(`evidence: ${parts.join(' ')}`)
  } else {
    lines.push('evidence: (none)')
  }
  if (receipt.modelMismatch === true) {
    lines.push(`mismatch: the target ran ${renderSelection(receipt.executedSelection)}; it was not switched back`)
  }
  if (receipt.reason !== undefined) lines.push(`reason: ${receipt.reason}`)
  if (receipt.status === 'unknown') {
    lines.push('do not retry with the same arguments: a retry derives a new message id and would deliver twice. Report this to the user and verify with shadow_inspect.')
  }
  return lines.join('\n')
}

/**
 * Hosts that never need an egress decision: the loopback the agent already owns.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

/** Tool names that can reach the network by themselves. */
const NETWORK_TOOL = /(^|[^a-z])(web[-_]?fetch|fetch|http|browse)([^a-z]|$)/i

/** Tool names that run a shell command, which can reach the network indirectly. */
const SHELL_TOOL = /(^|[^a-z])(pwsh|powershell|bash|zsh|sh|cmd|shell|terminal|exec)([^a-z]|$)/i

/** Shell clients that turn a command into an outbound request. */
const NETWORK_CLIENT = /curl|wget|invoke-webrequest|invoke-restmethod|\biwr\b|\birm\b|\bnc\b|netcat|\bftp\b|\bsftp\b|\bscp\b|\bssh\b|\btelnet\b/i

/** Absolute URL, enough to read a destination host out of a string. */
const ABSOLUTE_URL = /https?:\/\/([^\s/'"?`#]+)/gi

/**
 * Normalize one URL authority into a comparable host.
 * @param authority - the matched authority (`user:pass@host:port`).
 * @returns the lowercased host without credentials or port.
 */
function hostOf(authority) {
  const withoutCredentials = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  const withoutPort = withoutCredentials.startsWith('[')
    ? withoutCredentials.slice(0, withoutCredentials.indexOf(']') + 1)
    : withoutCredentials.split(':')[0]
  return withoutPort.toLowerCase()
}

/**
 * Collect the strings a tool call carries.
 *
 * Tool arguments are JSON from the model, so they are small and shallow; the
 * bounds only keep a pathological payload from turning the guard into a cost.
 * @param value - the value to walk.
 * @param out - accumulator for strings.
 * @param depth - remaining recursion depth.
 */
function collectStrings(value, out, depth) {
  if (depth < 0 || out.length > 200) return
  if (typeof value === 'string') {
    out.push(value.length > 20000 ? value.slice(0, 20000) : value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth - 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out, depth - 1)
  }
}

/**
 * Decide whether one tool call sends data to a destination this deployment did
 * not allow.
 *
 * The check is on the **destination**, never on the payload: encoding, splitting
 * or rewriting the content cannot change where a request goes, so this is a
 * property a rule can hold that a content pattern cannot. It is also deliberately
 * narrow — only calls that can reach the network at all are examined, which keeps
 * ordinary file writes (whose text may contain URLs) from asking permission.
 * @param facts - tool name, its arguments, and the allowed host list.
 * @returns the offending host and a reason, or undefined when nothing is outbound.
 */
export function inspectEgress({ toolName, args, allowlist = [] }) {
  const name = typeof toolName === 'string' ? toolName : ''
  const networkTool = NETWORK_TOOL.test(name)
  const shellTool = SHELL_TOOL.test(name)
  if (!networkTool && !shellTool) return undefined

  const strings = []
  collectStrings(args, strings, 4)

  // A shell call is only outbound when it names a network client or carries a URL.
  if (shellTool && !networkTool) {
    const reachesNetwork = strings.some((text) => ABSOLUTE_URL.test(text) || NETWORK_CLIENT.test(text))
    ABSOLUTE_URL.lastIndex = 0
    if (!reachesNetwork) return undefined
  }

  const allowed = allowlist
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.toLowerCase())
  const allowedSet = new Set(allowed)
  for (const text of strings) {
    for (const match of text.matchAll(ABSOLUTE_URL)) {
      const host = hostOf(match[1])
      if (host.length === 0 || LOCAL_HOSTS.has(host)) continue
      if (allowedSet.has(host)) continue
      if (allowed.some((entry) => entry.startsWith('.') && host.endsWith(entry))) continue
      return { host, reason: `this call sends data to "${host}", which is not in egressAllowlist` }
    }
  }
  return undefined
}

/**
 * Render the target catalog the model reads.
 *
 * One line per Session, with the facts that decide whether a dispatch can land:
 * the exact id to pass, the live state, and the markers that will refuse it.
 * The listing is a discovery aid; the refusal itself still comes from
 * `shadow_dispatch`.
 * @param result - workspaces in registry order, each with its sessions.
 * @returns the model-facing text.
 */
export function renderTargets(result) {
  const total = result.workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0)
  const lines = [`shadow_targets -> ${result.workspaces.length} workspaces, ${total} sessions shown`]
  for (const workspace of result.workspaces) {
    lines.push(`workspace ${workspace.id} "${workspace.title}"  ${workspace.path}`)
    if (workspace.sessions.length === 0) lines.push('  (no sessions)')
    for (const session of workspace.sessions) {
      const markers = [
        session.state,
        ...session.archived === true ? ['archived'] : [],
        ...session.subagent === true ? ['subagent'] : [],
      ]
      const title = session.title === undefined || session.title.length === 0 ? '(untitled)' : `"${session.title}"`
      lines.push(`  ${session.id}  ${markers.join(' ')}  ${title}`)
    }
    if (workspace.omitted > 0) lines.push(`  (${workspace.omitted} more: raise limit to see them)`)
  }
  lines.push('read one target exactly with shadow_inspect; deliver with shadow_dispatch.')
  return lines.join('\n')
}

/**
 * Render the inspection result the model reads.
 *
 * The directory, model, and sequence lines describe a Session that was actually
 * read; a refusal before the read omits them rather than printing placeholders.
 * @param result - state, target facts, an optional event page, and whether the log was probed.
 * @returns the model-facing text.
 */
export function renderInspection(result) {
  const lines = [`shadow_inspect -> ${result.state}`, `target: ${result.target}`]
  if (result.probed === true) {
    lines.push(`cwd: ${result.cwd ?? '(unknown)'}`)
    lines.push(`model: ${renderSelection(result.model ?? null)}`)
    lines.push(`asOfSeq: ${result.asOfSeq}`)
  }
  if (result.waitingUser === true) lines.push('waitingUser: true')
  if (result.inboxPending === true) lines.push('inboxPending: true')
  if (result.reason !== undefined) lines.push(`reason: ${result.reason}`)
  if (result.events !== undefined) {
    const page = result.eventPage
    lines.push(page === undefined
      ? `events (${result.events.length}):`
      : `events (${result.events.length} of ${page.total} after seq ${page.afterSeq}; last seq is ${page.lastSeq}):`)
    for (const line of result.events) lines.push(line)
    if (page !== undefined && result.events.length < page.total) {
      lines.push(`(${page.total - result.events.length} more: raise limit, or jump near the end with afterSeq ${page.lastSeq - page.limit})`)
    }
  }
  return lines.join('\n')
}
