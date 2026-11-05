/**
 * `shadow_inspect`: read one target's state and an optional event page without
 * activating it or sending anything.
 *
 * Layer: op. Imports: core-*. Read-only by construction: it only calls host
 * adapter reads (docs/detailed-design.md §4.4).
 */

import { INSPECT_PAGE_DEFAULT, INSPECT_PAGE_MAX, REASON, messageOf } from './core-contract.js'
import { currentSelection, pendingUserWait } from './core-log.js'
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
 * @param args - `{workspaceId, sessionId, afterSeq?, limit?}`.
 * @param exec - the executing tool call.
 * @returns the model-facing inspection text.
 */
export async function inspect(host, args, exec) {
  const targetRef = `${args.workspaceId}/${args.sessionId}`

  // I0 bind.
  const bound = host.bind(exec)
  if (bound.code !== undefined) {
    return renderInspection({ state: bound.code, target: targetRef, reason: bound.detail })
  }

  // I1 membership.
  const target = host.resolveTarget(args.workspaceId, args.sessionId)
  if (target.code !== undefined) {
    const miss = await host.classifyMiss(target, args.sessionId, exec.signal)
    return renderInspection({ state: miss.code, target: targetRef, reason: miss.detail })
  }

  // I2 read.
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
  })
}
