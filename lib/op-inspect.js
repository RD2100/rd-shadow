/**
 * `shadow_inspect`: read one target's state, an optional event page, and an
 * optional reply, without activating it or sending anything.
 *
 * Layer: op. Imports: core-*. Read-only by construction: it only calls host
 * adapter reads (docs/detailed-design.md §4.4).
 */

import { DispatchCoreError, INSPECT_PAGE_DEFAULT, INSPECT_PAGE_MAX, REASON, RUNTIME_MISMATCH_HINT, messageOf } from './core-contract.js'
import { currentSelection, pendingUserWait } from './core-log.js'
import { pageReply } from './core-reply-page.js'
import { renderInspection, summarizeEvent } from './core-render.js'

/**
 * Clamp a requested page size into [1, INSPECT_PAGE_MAX].
 * @param limit - the caller's value, possibly undefined.
 * @returns the effective page size.
 */
export function inspectPageLimit(limit) {
  const requested = typeof limit === 'number' ? limit : INSPECT_PAGE_DEFAULT
  return Math.min(Math.max(1, Math.trunc(requested)), INSPECT_PAGE_MAX)
}

/**
 * Run one inspection.
 * @param host - the host adapter from host-io.js.
 * @param args - `{workspaceId, sessionId, afterSeq?, limit?, replyAfterSeq?}`.
 * @param exec - the executing tool call.
 * @returns the model-facing inspection text.
 */
export async function inspect(host, args, exec) {
  const targetRef = `${args.workspaceId}/${args.sessionId}`
  try {
    return await inspectSteps(host, args, exec, targetRef)
  } catch (error) {
    if (error instanceof DispatchCoreError && error.code === REASON.runtimeMismatch) {
      return renderInspection({ state: REASON.runtimeMismatch, target: targetRef, reason: `${error.message}; ${RUNTIME_MISMATCH_HINT}` })
    }
    throw error
  }
}

/**
 * The inspection steps proper.
 * @param host - the host adapter.
 * @param args - tool arguments.
 * @param exec - the executing tool call.
 * @param targetRef - `<workspaceId>/<sessionId>`.
 * @returns the model-facing inspection text.
 */
async function inspectSteps(host, args, exec, targetRef) {
  // I0 bind.
  const bound = host.bind(exec)
  if (bound.code !== undefined) {
    return renderInspection({ state: bound.code, target: targetRef, reason: bound.detail })
  }

  // I0b service shape.
  if (host.contractProblems.length > 0) {
    return renderInspection({ state: REASON.runtimeMismatch, target: targetRef, reason: `${host.contractProblems.join('; ')}; ${RUNTIME_MISMATCH_HINT}` })
  }

  if ([args.deliveryMessageId, args.replyAfterSeq, args.replyCursor].filter((v) => v !== undefined).length > 1) {
    return renderInspection({ state: 'invalid-inspect-arguments', target: targetRef, reason: 'deliveryMessageId, replyAfterSeq and replyCursor are mutually exclusive' })
  }

  // I1 membership.
  const target = host.resolveTarget(args.workspaceId, args.sessionId)
  if (target.code !== undefined) {
    const miss = await host.classifyMiss(target, args.sessionId, exec.signal)
    return renderInspection({ state: miss.code, target: targetRef, reason: miss.detail })
  }

  // I2 read (throws runtime-mismatch on a drifted log; see inspect()).
  const log = await host.readLogOrNull(args.sessionId, exec.signal)
  if (log === null) {
    return renderInspection({ state: REASON.unknown, target: targetRef, reason: 'the Session has no readable log' })
  }

  // I3 state; a log that does not fold is reported as unknown with what was read.
  let state
  let inboxPending
  try {
    state = host.targetState(args.sessionId, log)
    inboxPending = host.inboxPending(log.events)
  } catch (error) {
    return renderInspection({
      state: REASON.unknown,
      target: targetRef,
      probed: true,
      cwd: log.header?.cwd,
      model: currentSelection(log.events),
      asOfSeq: log.cursor,
      reason: messageOf(error),
    })
  }

  // I4 optional event page.
  const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : undefined
  const pageLimit = inspectPageLimit(args.limit)
  const matching = afterSeq === undefined ? undefined : log.events.filter((event) => event.seq > afterSeq)
  const events = matching === undefined ? undefined : matching.slice(0, pageLimit).map(summarizeEvent)

  // I5 optional reply: what the target answered after one point in its log.
  const replyAfterSeq = typeof args.replyAfterSeq === 'number' ? Math.trunc(args.replyAfterSeq) : undefined
  const reply = replyAfterSeq === undefined && args.deliveryMessageId === undefined && args.replyCursor === undefined
    ? undefined
    : pageReply({ events: log.events, workspaceId: args.workspaceId, sessionId: args.sessionId,
      snapshotSeq: log.cursor, afterSeq: replyAfterSeq, deliveryMessageId: args.deliveryMessageId,
      inheritedEventCount: log.inheritedEventCount, cursor: args.replyCursor })
  if (reply?.pageError) {
    return renderInspection({ state: 'reply-page-error', target: targetRef, reason: reply.pageError })
  }

  return renderInspection({
    state,
    target: targetRef,
    probed: true,
    cwd: log.header?.cwd,
    model: currentSelection(log.events),
    asOfSeq: log.cursor,
    waitingUser: pendingUserWait(log.events),
    inboxPending,
    events,
    eventPage: matching === undefined ? undefined : { total: matching.length, afterSeq, lastSeq: log.cursor, limit: pageLimit },
    reply,
  })
}
