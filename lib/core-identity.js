/**
 * Dispatch identity and idempotency: which durable call is executing, and the
 * deterministic relay message it produces.
 *
 * Layer: core (pure). Imports: node:crypto, node:util, ./core-contract.js.
 * Invariant (DESIGN §5.3, docs/detailed-design.md §4.3): replaying one call
 * derives the same message id; a new call, target, content, or selection
 * derives a different one.
 */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DISPATCH_TOOL, DispatchCoreError, REASON } from './core-contract.js'

/** Prefix of every derived relay message id. */
const MESSAGE_ID_PREFIX = 'shadow-message-'

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
