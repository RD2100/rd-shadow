/**
 * `shadow_dispatch`: deliver one relay message and report what the target's log
 * proves about it.
 *
 * Layer: op. Imports: core-*, host-io (by parameter). This is the ONLY module
 * that performs effects on another Session: resolveAgent, selectModel, send.
 * The step numbers below are the state machine in docs/detailed-design.md §4.2;
 * keep them in sync when editing.
 */

import { CONTENT_MAX_LENGTH, DispatchCoreError, REASON, codeOf, messageOf } from './core-contract.js'
import { argumentsMatch, buildRelayMessage, deriveIdentity, deriveMessageId, findDispatchCall } from './core-identity.js'
import { currentSelection, deliveryEvidence, selectionMismatch } from './core-log.js'
import { isReceivable } from './core-admission.js'

/**
 * Build one rejection receipt.
 * @param code - one stable code from REASON (or a host error code).
 * @param detail - optional human-readable cause.
 * @returns the rejection receipt.
 */
export function reject(code, detail) {
  return {
    status: 'rejected',
    selected: null,
    evidence: null,
    reason: detail === undefined ? code : `${code} (${detail})`,
  }
}

/**
 * Verify the live target is exactly the Session this dispatch measured (D8/D10).
 * @param host - the host adapter.
 * @param sessionId - the target Session id.
 * @param workspace - the workspace the target must belong to.
 * @param agent - the resolved live Agent.
 * @param fresh - a log read taken after resolution.
 * @returns `{ok: true}`, or `{code, detail}`.
 */
export function liveReady(host, sessionId, workspace, agent, fresh) {
  if (agent?.session?.id !== sessionId) {
    return { code: REASON.sessionDetached, detail: `the target resolved to "${String(agent?.session?.id)}"` }
  }
  if (host.isArchived(sessionId)) return { code: REASON.archived, detail: 'the target became archived' }
  if (!workspace.sessionIds.includes(sessionId)) {
    return { code: REASON.workspaceMismatch, detail: 'the target left the workspace' }
  }
  if (agent.status !== 'idle') return { code: REASON.busy, detail: `the target is ${String(agent.status)}` }
  if (host.inboxPending(fresh.events)) return { code: REASON.pending, detail: 'the target has pending input' }
  if (agent.session.seq - 1 !== fresh.cursor) {
    return { code: REASON.sessionChanged, detail: `the target log advanced past ${String(fresh.cursor)}` }
  }
  return { ok: true }
}

/**
 * Run one dispatch. Callers serialize per target (core-serial.js).
 * @param host - the host adapter from host-io.js.
 * @param args - validated tool arguments `{workspaceId, sessionId, content, selection?}`.
 * @param exec - the executing tool call `{agent, callId, arguments, signal}`.
 * @returns the receipt object rendered by renderDispatchReceipt.
 */
export async function dispatch(host, args, exec) {
  const { scope } = host
  const signal = exec.signal

  // D0 bind: the caller must be the shadow itself.
  const bound = host.bind(exec)
  if (bound.code !== undefined) return reject(bound.code, bound.detail)
  const senderSessionId = bound.caller.session.id

  // D1 content.
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (content.length === 0) return reject(REASON.invalidContent, 'content must not be empty')
  if (content.length > CONTENT_MAX_LENGTH) {
    return reject(REASON.invalidContent, `content exceeds ${String(CONTENT_MAX_LENGTH)} characters`)
  }

  // D2 target membership.
  const resolvedTarget = host.resolveTarget(args.workspaceId, args.sessionId)
  if (resolvedTarget.code !== undefined) {
    const miss = await host.classifyMiss(resolvedTarget, args.sessionId, signal)
    return reject(miss.code, miss.detail)
  }
  const workspace = resolvedTarget.workspace

  // D3 identity: anchor to the durable call in the shadow's own log.
  const shadowLog = await host.readLog(senderSessionId, signal)
  const call = findDispatchCall({ events: shadowLog.events, callId: exec.callId })
  if (call === null) {
    throw new DispatchCoreError(REASON.unknown, `the executing call ${exec.callId} is not in this Session's log`)
  }
  if (!argumentsMatch(call.arguments, exec.arguments)) {
    return reject(REASON.identityConflict, 'the logged call does not carry these arguments')
  }
  const identity = deriveIdentity({ sessionId: senderSessionId, callId: exec.callId, kind: call.kind })

  const target = await host.readLogOrNull(args.sessionId, signal)
  if (target === null) return reject(REASON.sessionNotFound, `session "${args.sessionId}" has no log`)

  // D6 model selection (resolved before the message id, which covers it).
  let selected = null
  if (args.selection !== undefined) {
    try {
      await scope.llm.resolveModelInfo(args.selection.provider, args.selection.model, signal)
    } catch (error) {
      return reject(REASON.modelUnavailable, `${args.selection.provider}/${args.selection.model}: ${messageOf(error)}`)
    }
    selected = {
      provider: args.selection.provider,
      model: args.selection.model,
      ...args.selection.reasoningEffort === undefined ? {} : { reasoningEffort: args.selection.reasoningEffort },
    }
  } else {
    // An Agent with no request yet has no recorded selection; the official
    // session controller falls back to the deployment default the same way.
    selected = currentSelection(target.events) ?? host.defaultSelection()
    if (selected === null) {
      return reject(REASON.modelUnavailable, 'the target records no model selection; pass selection explicitly')
    }
  }

  const messageId = deriveMessageId({
    identity,
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    senderSessionId,
    provider: selected.provider,
    model: selected.model,
    reasoningEffort: selected.reasoningEffort,
    content,
  })
  const message = buildRelayMessage({ messageId, content, senderSessionId })
  const targetRef = `${args.workspaceId}/${args.sessionId}`
  const refuse = (code, detail) => ({ ...reject(code, detail), target: targetRef, messageId })

  // D4 observe first: a replay finds its own earlier delivery.
  const early = deliveryEvidence({ events: target.events, inheritedEventCount: target.inheritedEventCount, message })
  if (early !== null) {
    return { status: 'already-delivered', selected, evidence: early, target: targetRef, messageId }
  }

  // D5 admission.
  const state = host.targetState(args.sessionId, target)
  if (!isReceivable(state)) return refuse(state, 'the target cannot receive work right now')

  // D7 resolve (wakes a cold target).
  const resolved = await scope.sessionController.resolveAgent(args.sessionId)
  if ('error' in resolved) return refuse(codeOf(resolved.error), messageOf(resolved.error))
  const agent = resolved.agent

  // D8 live readiness on a fresh read.
  const fresh = await host.readLogOrNull(args.sessionId, signal)
  if (fresh === null) return refuse(REASON.sessionDetached, 'the target log disappeared')
  const ready = liveReady(host, args.sessionId, workspace, agent, fresh)
  if (ready.code !== undefined) return refuse(ready.code, ready.detail)

  // D9 apply an explicit selection.
  if (args.selection !== undefined) {
    const applied = await scope.sessionController.selectModel({
      sessionId: args.sessionId,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    })
    if ('error' in applied) return refuse(codeOf(applied.error), messageOf(applied.error))
  }

  // D10 recheck after the selection write.
  const settled = await host.readLogOrNull(args.sessionId, signal)
  if (settled === null) return refuse(REASON.sessionDetached, 'the target log disappeared')
  const recheck = liveReady(host, args.sessionId, workspace, agent, settled)
  if (recheck.code !== undefined) return refuse(recheck.code, recheck.detail)

  // D11 send. Before this line every failure is `rejected`; after it, `unknown`.
  try {
    agent.send(message, 'next-turn', true)
  } catch (error) {
    return refuse(REASON.sessionDetached, messageOf(error))
  }

  // D12 evidence.
  try {
    const after = await host.readLogOrNull(args.sessionId, signal)
    if (after === null) {
      return { status: 'unknown', selected, evidence: null, target: targetRef, messageId, reason: 'the target log became unreadable after the send' }
    }
    const evidence = deliveryEvidence({ events: after.events, inheritedEventCount: after.inheritedEventCount, message })
    if (evidence === null) {
      return { status: 'unknown', selected, evidence: null, target: targetRef, messageId, reason: 'the message is not visible in the target log after the send' }
    }
    const executed = evidence.execution?.selection
    return {
      status: evidence.userSeq === null ? 'accepted' : 'durable',
      selected,
      evidence,
      target: targetRef,
      messageId,
      ...executed !== undefined && selectionMismatch(executed, selected)
        ? { modelMismatch: true, executedSelection: executed }
        : {},
    }
  } catch (error) {
    // D13: after the send, losing confirmation is `unknown`, never `rejected`.
    return { status: 'unknown', selected, evidence: null, target: targetRef, messageId, reason: messageOf(error) }
  }
}
