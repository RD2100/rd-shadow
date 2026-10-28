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
const NETWORK_TOOL = /(^|[^a-z])(web[-_]?fetch|fetch|http|browse|web[-_]?search|websearch)([^a-z]|$)/i

/**
 * Network tools whose destination is the tool's own server (a search engine),
 * not an argument this guard can read.
 */
const SEARCH_TOOL = /search/i

/**
 * Tool names owned by an external server (MCP): the call leaves the process no
 * matter what the arguments look like, so destination rules cannot apply.
 */
/**
 * Tools served by an MCP server: the host runs the server, so the arguments
 * carry no destination this process can read. Every name the host registers
 * that carries `mcp` as its own field counts — the double-underscore tool form
 * (`mcp__srv__tool`), the hyphenated form (`mcp-srv`), and the resource
 * readers (`read_mcp_resource`, `list_mcp_resources`), which read from a server
 * that may live on the network. A name with `mcp` inside a word (`xmcp`) is not
 * one.
 */
const REMOTE_TOOL = /(^|[^a-z])mcp([^a-z]|$)/i

/** Tool names that run a shell command, which can reach the network indirectly. */
const SHELL_TOOL = /(^|[^a-z])(pwsh|powershell|bash|zsh|sh|cmd|shell|terminal|exec|python|node|deno|ruby|perl|php)([^a-z]|$)/i

/**
 * Tool names whose arguments are code, not a command line: everything they
 * carry is executable, so a URL in them is never prose.
 */
const INTERPRETER_TOOL = /(^|[^a-z])(python|node|deno|ruby|perl|php)([^a-z]|$)/i

/** Shell clients that turn a command into an outbound request. */
const NETWORK_CLIENT = /^(?:curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|nc|netcat|ftp|sftp|scp|ssh|telnet)(?:\s|$)/i

/**
 * Command words this guard cannot read at a segment's start: a variable holds
 * the real name (`& $client host`, `$env:ComSpec /c curl host`), and a string
 * evaluator runs whatever its argument says (`iex "curl.exe host"`). Both put
 * the command somewhere the anchored patterns cannot see, so the rest of the
 * segment is searched for the command instead — found by a real probe, not
 * imagined: every one of those spellings used to pass in silence.
 */
const UNREADABLE_COMMAND = /^\$(?:\{|env:|[A-Za-z_@])|^(?:iex|invoke-expression)\b/i

/**
 * The only argument that makes a client ask nothing of the network: it prints
 * the program's own version or help and exits. Deliberately exact — it must be
 * the *only* argument, because `-V host` still connects, and it is
 * case-sensitive, because curl's `-v` is verbose and `-H` is a header. Both of
 * those send.
 */
const VERSION_QUERY = /^(?:--version|--help|-V|-h|-\?)$/

/**
 * Commands that send data out while their destination never appears in the
 * arguments: a repository remote, a registry, an image host, a configured host
 * alias. With no URL to compare, no allowlist decision is possible, so these
 * always ask — only the tool knows where it is about to send. The second
 * alternatives cover the value-taking `-c`/`-C` options git accepts before the
 * subcommand.
 */
const OPAQUE_EGRESS = [
  /^git\s+(?:-\S+\s+)*push\b/i,
  /^git\s+-[cC]\s+\S+\s+push\b/i,
  /^git\s+(?:-\S+\s+)*remote\s+(?:add|set-url)\b/i,
  /^git\s+(?:-\S+\s+)*(?:send-email|imap-send|svn)\b/i,
  /^git\s+(?:-\S+\s+)*submodule\s+(?:add|update|sync)\b/i,
  /^(?:npm|pnpm|yarnpkg|yarn)\s+(?:run\s+)?publish\b/i,
  /^docker\s+(?:push|login)\b/i,
  // The GitHub CLI talks to api.github.com (or an enterprise host set by
  // GH_HOST), and the arguments never say which; only the version, help, and
  // read-only status/config queries stay local.
  /^gh\s+(?!--?(?:version|help)\b|auth\s+status\b|config\s+get\b)\S+/i,
  /^(?:hg|svn)\s+(?:push|commit|copy|import)\b/i,
  /^rsync\b/i,
  /^scp\b/i,
  /^sftp\b/i,
  /^ssh\b/i,
  /^telnet\b/i,
  /^nc\b/i,
  /^netcat\b/i,
  /^ftp\b/i,
  /^(?:aws|az|gcloud|gsutil|azcopy)\s+\S+/i,
  /^Start-BitsTransfer\b|^bitsadmin\b/i,
  /^(?:psql|mysql|mongo|mongosh|sqlcmd|redis-cli)\s/i,
  /^(?:nslookup|dig|resolve-dnsname|test-netconnection)\b/i,
]

/**
 * Commands whose destination can itself be a readable URL, so the ordinary
 * allowlist check applies to them. Over a configured remote or the scp-style
 * syntax they carry no host to compare — those are handled like the opaque
 * commands above.
 */
const URL_DESTINATION = [
  /^git\s+(?:-\S+\s+)*(?:clone|fetch|pull|ls-remote|archive\s+--remote)\b/i,
  /^git\s+-[cC]\s+\S+\s+(?:clone|fetch|pull)\b/i,
  /^(?:hg|svn)\s+(?:clone|checkout|update|switch|export)\b/i,
]

/**
 * Commands that can act on a URL in their own arguments: network clients, the
 * shells and interpreters that can run one, and the remote tools that take a
 * URL as their destination. A URL anywhere else in a command is data — a commit
 * message, an echo, a comment — and decides nothing.
 */
const URL_EXECUTOR = [
  NETWORK_CLIENT,
  /^(?:pwsh|powershell|bash|zsh|sh|cmd|shell|terminal|exec|python|node|deno|ruby|perl|php)(?:\s|$)/i,
  /^(?:npm|pnpm|yarnpkg|yarn)\s/i,
  ...URL_DESTINATION,
]

/**
 * URL schemes that stay inside the machine: fetching one is a local read, not
 * an outbound send, so the guard has nothing to ask about. The leading
 * character class keeps a path fragment like `/data:foo` from matching.
 */
const LOCAL_SCHEME = /(?:^|[\s"'`(=])(?:data|blob|about):/i

/**
 * A URL on a protocol this guard cannot judge: the allowlist compares hosts,
 * and only HTTP(S) URLs carry one in a readable position.
 */
const NON_HTTP_URL = /\b(?:ftp|sftp|ssh|git|ws|wss|smb|tcp):\/\//i

/**
 * Split a shell command into the segments the chaining operators separate.
 *
 * A URL check must be answered per segment: `git push && curl https://ok.test`
 * carries a readable URL, but the push half of it does not, and it is the half
 * that sends. The split ignores separators inside quotes, so
 * `git commit -m "a && b"` is one segment and `python -c "a;urlopen(x)"` is one
 * python call rather than two commands.
 * @param text - one command string.
 * @returns the segments, each still a whole string.
 */
function segmentsOf(text) {
  const segments = []
  let current = ''
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      // `&&`, `||`, `|`, `&` and `;` all end a segment; a doubled operator is
      // consumed whole so it does not leave an empty segment behind.
      segments.push(current)
      current = ''
      if (text[index + 1] === char) index += 1
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Spans a shell runs as commands inside a larger command: `$(...)`, backtick
 * substitution, and `{ ... }` blocks. Their contents are analysed like any
 * command, so a client hidden inside a substitution cannot borrow the outer
 * command's innocent segment start — `echo $(curl https://evil.test)` is an
 * outbound call, not prose about one.
 * @param text - one command string.
 * @param depth - remaining nesting levels to follow.
 * @returns the spans' contents, flattened.
 */
function executableSpansOf(text, depth = 2) {
  if (depth < 0) return []
  const found = []
  const pattern = /\$\(([^()]*)\)|`([^`]*)`|\{([^{}]*)\}/g
  for (const match of text.matchAll(pattern)) {
    const inner = match[1] ?? match[2] ?? match[3] ?? ''
    if (inner.length === 0) continue
    found.push(inner)
    found.push(...executableSpansOf(inner, depth - 1))
  }
  return found
}

/**
 * Wrappers a shell allows between a chaining operator and the real command:
 * `sudo`, `env X=1`, `Start-Process -Args x`, the call operator `&`, the
 * opening parenthesis of a subshell, and the shells that only forward —
 * `cmd /c curl …`, `powershell -c "curl …"`. Stripping them keeps a command
 * recognisable wherever it legitimately starts.
 */
const COMMAND_WRAPPERS = /^\s*(?:\(\s*|sudo\s+|time\s+|env\s+\S+\s+|Start-Process\s+(?:-\S+\s+\S+\s+)*|&\s*|(?:cmd|pwsh|powershell|bash|zsh|sh)\s+(?:\/[ck]\s+|-\w+\s+)*)*/i

/**
 * The part of a segment where a command name can actually start.
 *
 * Four spellings put the command somewhere the anchored patterns cannot see
 * it, and each was found by a real attempt rather than imagined: Windows runs
 * `git.exe` and `npm.cmd` where Unix runs `git` and `npm`; a full path
 * (`C:\Windows\System32\curl.exe`) names the program after its last separator;
 * a forwarding shell leaves the command inside quotes (`powershell -c "curl
 * evil.test"`); and an executable suffix can hide the forwarding shell itself
 * (`cmd.exe /c curl …`). All are normalized away here, so one place decides
 * what the command is instead of every pattern guessing.
 * @param segment - one command segment.
 * @returns the segment with its command head in plain form.
 */
function commandHead(segment) {
  let head = segment.replace(COMMAND_WRAPPERS, '')
  // Each round removes characters and never adds any, so the loop is bounded
  // and monotonic: `cmd.exe /c curl.exe x` needs a suffix strip to expose the
  // wrapper, and the wrapper strip to expose the inner `.exe`.
  for (let round = 0; round < 4; round += 1) {
    const next = withoutExecutableSuffix(head)
      .replace(COMMAND_WRAPPERS, '')
      .replace(/^["'`]/, '')
    if (next === head) break
    head = next
  }
  return head
}

/**
 * Drop a path and an executable suffix from the first word: `C:\…\curl.exe`
 * and `npm.cmd` both name the program the bare command names. Quotes around
 * the word go with it — `& "curl.exe" x` invokes curl. A trailing dot goes too:
 * Windows path parsing accepts `curl.exe.` where a filter looking for `.exe`
 * at the end of the word does not.
 * @param head - a command segment.
 * @returns the same segment with its first word in bare form.
 */
function withoutExecutableSuffix(head) {
  const word = /^\S+/.exec(head)?.[0]
  if (word === undefined) return head
  const unquoted = word.replace(/^["'`]/, '').replace(/["'`]$/, '')
  const bare = unquoted.replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|com|ps1)\.?$/i, '')
  return bare + head.slice(word.length)
}

/**
 * The command word a segment starts with, wrappers and executable suffixes
 * stripped. A word that resolves to a variable (`$client https://…`) is kept
 * verbatim: the guard cannot follow the assignment, so an unrecognised word
 * fails closed.
 * @param segment - one command segment.
 * @returns the lowercased command word, or an empty string.
 */
function commandWord(segment) {
  return /^[A-Za-z0-9_.$@\\/:-]+/.exec(commandHead(segment))?.[0]?.toLowerCase() ?? ''
}

/**
 * Commands whose arguments are data rather than destinations. A URL inside one
 * of them is prose — a commit message, a log line — so it decides nothing.
 * Every command that can carry a URL as its destination is either an executor
 * above or one of the remote tools, which their own patterns already cover.
 */
const DATA_ONLY_COMMAND = /^(?:echo|write-(?:output|host|information|warning|error|verbose|debug)|out-(?:file|string)|set-content|add-content|new-item|git|hg|svn|docker|kubectl|helm|terraform|make|cmake|dotnet|go|cargo|rustc|mvn|gradle)$/i

/**
 * Whether a URL in this segment names a destination rather than prose.
 *
 * A URL decides when a command that can act on it starts the segment: a network
 * client, a shell or interpreter, a package manager, or one of the remote tools
 * whose destination is the URL. A command the guard does not recognise fails
 * closed — `$client https://evil.test` resolves the client in a variable this
 * guard cannot read, so it asks. Only the data-only commands carry URLs as
 * prose, and their destination-bearing subcommands are covered by the remote
 * tool patterns instead.
 * @param segment - one command segment.
 * @returns true when a URL here is a destination.
 */
function countsAsDestination(segment) {
  if (URL_EXECUTOR.some((pattern) => startsCommand(segment, pattern))) return true
  if (URL_DESTINATION.some((pattern) => startsCommand(segment, pattern))) return true
  const word = commandWord(segment)
  return word.length === 0 || !DATA_ONLY_COMMAND.test(word)
}

/**
 * Whether one segment invokes a command matching the pattern at its start.
 *
 * A command name anywhere else in the text is data — a commit message, an echo,
 * a comment — and must not decide anything: `git commit -m "docs: ssh usage"`
 * is prose about ssh, not an ssh call.
 * @param segment - one command segment.
 * @param pattern - the command pattern, matched from the segment start.
 * @returns true when the segment starts with that command.
 */
function startsCommand(segment, pattern) {
  const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace('g', ''))
  return anchored.test(commandHead(segment))
}

/**
 * Whether one segment invokes a command matching the pattern, including the
 * spellings that hide the command from the anchored match.
 *
 * A variable or a string evaluator at the segment start means the real command
 * is not in the segment head, so the pattern is searched through the rest of
 * the segment instead: `iex "curl.exe host"` and `$env:ComSpec /c curl host`
 * both name a client the anchored match cannot see. A plain unknown word
 * (`grep curl file`) does not qualify — the guard cannot read every command
 * name in the world, and searching those would ask about searching a file.
 * @param segment - one command segment.
 * @param pattern - the command pattern.
 * @returns true when this segment invokes that command.
 */
function startsCommandUnreadable(segment, pattern) {
  if (startsCommand(segment, pattern)) return true
  if (!UNREADABLE_COMMAND.test(commandHead(segment))) return false
  return looseOf(pattern).test(segment)
}

/**
 * The same command pattern without its start anchor, so it can be searched for
 * inside a segment whose head the guard cannot read. A client name may carry an
 * executable suffix there — `iex "curl.exe host"` spells curl with one — which
 * the anchored pattern's `(?:\s|$)` would not match.
 * @param pattern - a command pattern.
 * @returns the pattern, unanchored.
 */
function looseOf(pattern) {
  const source = pattern.source.replace(/^\^/, '')
  return new RegExp(
    source.includes('(?:\\s|$)') ? source.replace('(?:\\s|$)', '(?:\\.\\w+)?(?:\\s|$)') : source,
    pattern.flags.replace('g', ''),
  )
}

/**
 * Command names a segment's variables hold, resolved from this same command
 * line: `$c = "curl.exe"; & $c host` runs curl, and the only place the name
 * appears is the assignment. PowerShell keeps no state between calls, so the
 * assignment is always in the same text when it matters.
 * @param segments - the command's segments, in order.
 * @returns a map from variable name to the literal it was assigned.
 */
function assignmentsIn(segments) {
  const found = new Map()
  for (const segment of segments) {
    const match = /^\s*\$\{?([A-Za-z_@][\w@]*)\}?\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(segment)
    const value = (match?.[2] ?? match?.[3] ?? match?.[4] ?? '').trim()
    if (match && value.length > 0) found.set(match[1].toLowerCase(), value)
  }
  return found
}

/**
 * Replace a variable command word with the literal it was assigned, so the
 * anchored patterns see the command that will actually run.
 * @param segment - one command segment.
 * @param assignments - the variables this command line assigns.
 * @returns the segment with its command word resolved when it is a variable.
 */
function resolveCommandWord(segment, assignments) {
  if (assignments.size === 0) return segment
  const head = commandHead(segment)
  const word = /^\S+/.exec(head)?.[0] ?? ''
  const name = /^\$\{?([A-Za-z_@][\w@]*)\}?$/.exec(word)?.[1]
  if (name === undefined) return segment
  const value = assignments.get(name.toLowerCase())
  return value === undefined ? segment : value + head.slice(word.length)
}

/**
 * Whether a client call only reports its own version or help, which reaches
 * nowhere and so is not an egress. `curl --version` and `ssh -V` are the
 * common ones; `curl -H … host` is not, because `-H` is a header.
 * @param segment - one command segment.
 * @returns true when the segment is a version or help query.
 */
function isVersionQuery(segment) {
  const head = commandHead(segment)
  const word = /^\S+/.exec(head)?.[0] ?? ''
  if (word.length === 0) return false
  return VERSION_QUERY.test(head.slice(word.length).trim())
}

/** Absolute URL, enough to read a destination host out of a string. */
const ABSOLUTE_URL = /https?:\/\/([^\s/'"?`#]+)/gi

/**
 * Path fragments that mark data worth protecting, matched case-insensitively.
 *
 * These are deliberately names rather than content patterns: a file that holds
 * credentials is knowable from its path, while whether a given string *looks*
 * like a secret is not. Override with the `protectedPaths` row config.
 */
export const DEFAULT_PROTECTED_PATHS = Object.freeze([
  '.credentials',
  '.env',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.pfx',
  'secrets',
])

/**
 * Whether one tool call touches protected data.
 *
 * Any argument that names a protected path counts, including a directory
 * listing or a shell command that only mentions the file: the point is to know
 * that protected data entered the conversation, not to prove it was copied.
 * @param facts - tool name, its arguments, and the protected path fragments.
 * @returns the matched fragment, or undefined when nothing protected is named.
 */
export function touchesProtected({ args, protectedPaths = DEFAULT_PROTECTED_PATHS }) {
  const markers = protectedPaths
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map((entry) => entry.toLowerCase())
  if (markers.length === 0) return undefined

  const strings = []
  collectStrings(args, strings, 4)
  for (const text of strings) {
    const lowered = text.toLowerCase()
    for (const marker of markers) {
      if (lowered.includes(marker)) return marker
    }
  }
  return undefined
}

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
 * @param facts - tool name, its arguments, the allowed host list, and whether
 *   this turn already touched protected data.
 * @returns the offending host and a reason, or undefined when nothing is outbound.
 */
export function inspectEgress({ toolName, args, allowlist = [], tainted = false }) {
  const name = typeof toolName === 'string' ? toolName : ''
  const networkTool = NETWORK_TOOL.test(name)
  const shellTool = SHELL_TOOL.test(name)
  if (!networkTool && !shellTool && !REMOTE_TOOL.test(name)) return undefined

  const strings = []
  collectStrings(args, strings, 4)

  // The text a shell will actually run as commands: the arguments themselves,
  // plus the spans it executes inside them — `$(...)`, backticks, `{ ... }`.
  // Every pattern below is answered over these, so a client hidden in a
  // substitution is seen even though the outer segment starts with `echo`.
  const commandTexts = shellTool
    ? [...strings, ...strings.flatMap((text) => executableSpansOf(text))]
    : strings
  const rawSegments = commandTexts.flatMap(segmentsOf)
  // A command name held in a variable is still a command name. PowerShell keeps
  // no state between calls, so when `& $c host` runs a client the assignment is
  // in the same command line; resolving it here lets every pattern below see
  // the command that will actually run.
  const assignments = assignmentsIn(rawSegments)
  const segments = rawSegments.map((segment) => resolveCommandWord(segment, assignments))

  // Texts whose URLs this guard lets decide. A network tool carries its
  // destination in a structured argument, so every string it holds is a
  // candidate. An interpreter's arguments are code, so the same holds. A shell
  // command line is prose as much as command: a URL decides when a command that
  // can act on it starts the segment, and a command the guard does not know
  // fails closed — only the data-only commands below carry URLs as prose.
  const urlTexts = !shellTool
    ? strings
    : (INTERPRETER_TOOL.test(name)
      ? strings
      : segments.filter((segment) => countsAsDestination(segment)))

  // A tool backed by an external server sends wherever that server is; the
  // arguments carry no destination, so it can only be reported.
  if (!networkTool && !shellTool && REMOTE_TOOL.test(name)) {
    return {
      host: 'an external tool server',
      reason: `"${name}" is served outside this process, so its destination cannot be checked`,
      opaque: true,
    }
  }

  // A command whose destination is a configured remote cannot be judged by an
  // allowlist — there is no host to compare — so it always asks. Only a command
  // at the start of a segment counts: a name in prose is data, not a call.
  if (shellTool) {
    // A version or help query reaches nowhere, so it is not an egress even when
    // the command is one of the opaque ones: `ssh -V` prints a version.
    const outbound = segments.filter((segment) => !isVersionQuery(segment))
    const opaque = OPAQUE_EGRESS.find((pattern) => outbound.some((segment) => startsCommandUnreadable(segment, pattern)))
    if (opaque !== undefined) {
      const named = outbound.find((segment) => startsCommandUnreadable(segment, opaque)) ?? ''
      return {
        host: 'a configured remote',
        reason: `"${named.trim().slice(0, 60)}" sends data to a destination that is not in its arguments, so it cannot be checked against egressAllowlist`,
        opaque: true,
      }
    }
    // A clone/fetch/pull names its remote as a URL, so the ordinary host check
    // below covers it; the same command over a configured remote or the
    // scp-style syntax carries no host to compare, so it asks. Per segment, so
    // chaining an allowlisted call onto it cannot launder it.
    const unreadableRemote = segments.find((segment) => URL_DESTINATION.some((pattern) => startsCommand(segment, pattern))
      && !/https?:\/\//i.test(segment))
    if (unreadableRemote !== undefined) {
      return {
        host: 'a configured remote',
        reason: 'this command reaches a remote whose address is not a readable URL, so it cannot be checked against egressAllowlist',
        opaque: true,
      }
    }
    // A destination on any protocol but HTTP(S) carries no host this guard can
    // compare, so it asks rather than passing on an unreadable address.
    if (segments.some((segment) => NON_HTTP_URL.test(segment))) {
      return {
        host: 'a non-HTTP destination',
        reason: 'this command names a destination on a protocol other than HTTP(S), which egressAllowlist cannot match',
        opaque: true,
      }
    }
    // A network client is only outbound when it can act on a URL; one that
    // names no readable destination asks, because silence there is exactly an
    // exfiltration. A client that only prints its version or help reaches
    // nowhere, so it stays quiet — asking about `curl --version` would train
    // the operator to click through the questions that matter.
    const clientSegments = segments.filter((segment) => startsCommandUnreadable(segment, NETWORK_CLIENT))
    const namesClient = clientSegments.length > 0
    const onlyVersionQueries = namesClient
      && clientSegments.every((segment) => startsCommand(segment, NETWORK_CLIENT) && isVersionQuery(segment))
    const showsUrl = urlTexts.some((text) => /https?:\/\//i.test(text))
    if (!namesClient && !showsUrl) return undefined
    if (namesClient && !showsUrl && !onlyVersionQueries) {
      return {
        host: 'an unreadable destination',
        reason: 'this command names a network client but carries no URL this guard can read, so its destination cannot be checked',
        opaque: true,
      }
    }
  }

  const allowed = allowlist
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.toLowerCase())
  const allowedSet = new Set(allowed)
  let sawUrl = false
  for (const text of urlTexts) {
    for (const match of text.matchAll(ABSOLUTE_URL)) {
      sawUrl = true
      const host = hostOf(match[1])
      if (host.length === 0 || LOCAL_HOSTS.has(host)) continue
      // A turn that touched protected data does not get to use the allowlist:
      // knowing where it may send says nothing about what it is carrying.
      if (!tainted) {
        if (allowedSet.has(host)) continue
        if (allowed.some((entry) => entry.startsWith('.') && host.endsWith(entry))) continue
      }
      return {
        host,
        reason: tainted
          ? `this turn read protected data, so sending to "${host}" needs confirmation`
          : `this call sends data to "${host}", which is not in egressAllowlist`,
      }
    }
  }
  // A network tool with no readable destination sends to a server this guard
  // cannot name. A search runs against the tool's own server, so it stays quiet
  // until the turn carries protected data; a fetch or browse names its
  // destination in an argument, so an unreadable one can only ask. A URL scheme
  // that stays on the machine (data:, blob:, about:) is a local read instead.
  if (networkTool && !sawUrl) {
    if (strings.some((text) => LOCAL_SCHEME.test(text))) {
      return undefined
    }
    if (!SEARCH_TOOL.test(name)) {
      return {
        host: 'an unreadable destination',
        reason: 'this call reaches the network but its destination cannot be read from the arguments',
        opaque: true,
      }
    }
    if (tainted) {
      return {
        host: 'an unnamed destination',
        reason: 'this turn read protected data, and this call reaches a server whose address is not in the arguments',
        opaque: true,
      }
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
