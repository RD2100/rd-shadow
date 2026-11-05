/**
 * Folds over one Session's durable event log: current model selection, inbox
 * queues, open user waits, and the delivery evidence of one relay message.
 *
 * Layer: core (pure). Imports: node:util, ./core-contract.js.
 * Rule: a log that cannot be folded fails loud (DispatchCoreError), never reads
 * as "empty".
 */

import { isDeepStrictEqual } from 'node:util'
import { DispatchCoreError, REASON } from './core-contract.js'

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
