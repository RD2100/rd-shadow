/**
 * Host adapter for the agent-scoped tools: every read of host state the three
 * tools share, behind one object.
 *
 * Layer: host-io. Imports: core-* and shadow-dir.js only. Performs reads; never
 * sends, selects, or activates. The only effectful calls (resolveAgent,
 * selectModel, agent.send) live in op-dispatch.js so the effect boundary is one
 * file (docs/detailed-design.md §3.7).
 */

import { DispatchCoreError, REASON, codeOf } from './core-contract.js'
import { decideTargetState, sessionIdSuggestion } from './core-admission.js'
import { foldInbox, pendingUserWait } from './core-log.js'
import { eventProblems, leaseProblems, toolServiceProblems } from './core-shape.js'
import { directoryKey } from './shadow-dir.js'

/** Session-query code for a Session absent from both the live table and persistence. */
const SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

/**
 * Throw the one error every op maps to a `runtime-mismatch` result.
 * @param what - which read drifted.
 * @param problems - non-empty problem list from core-shape.js.
 */
function mismatch(what, problems) {
  throw new DispatchCoreError(REASON.runtimeMismatch, `${what}: ${problems.join('; ')}`)
}

/**
 * Wrap the injected host services for one plugin instance.
 * @param scope - the injected host services (agents, llm, sessionController, sessionQuery, sessions, workspaceRegistry).
 * @param options - `shadowDir` (normalized directory key) and `get` (the ctx service lookup).
 * @returns the adapter. `contractProblems` lists service-shape drift found at mount; ops refuse while it is non-empty.
 */
export function createHost(scope, { shadowDir, get }) {
  /** Checked once: services do not change shape while a plugin instance lives. */
  const contractProblems = toolServiceProblems(scope)

  /**
   * Read one Session's durable log without activating it.
   * @param sessionId - the Session to observe.
   * @param signal - cancellation for the read.
   * @returns header, events, inherited-event count, last-committed cursor, and liveness.
   * @throws DispatchCoreError `runtime-mismatch` when the lease or a folded event has drifted.
   */
  const readLog = async (sessionId, signal) => {
    const lease = await scope.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
    try {
      const shape = leaseProblems(lease)
      if (shape.length > 0) mismatch(`observeSession(${sessionId})`, shape)
      const events = [...lease.events]
      const drift = eventProblems(events)
      if (drift.length > 0) mismatch(`events of ${sessionId}`, drift)
      return {
        header: lease.header,
        events,
        inheritedEventCount: lease.inheritedEventCount,
        cursor: lease.cursor,
        live: lease.source === 'live',
      }
    } finally {
      lease?.[Symbol.dispose]?.()
    }
  }

  /**
   * Read one Session's log, reporting an absent Session as null.
   * @param sessionId - the Session to observe.
   * @param signal - cancellation for the read.
   * @returns the log, or null when the Session has no readable record.
   */
  const readLogOrNull = async (sessionId, signal) => {
    try {
      return await readLog(sessionId, signal)
    } catch (error) {
      if (codeOf(error) === SESSION_NOT_FOUND) return null
      throw error
    }
  }

  /**
   * Whether one Session id is in the registry's archive set.
   * @param sessionId - the Session to test.
   * @returns true when archived.
   */
  const isArchived = (sessionId) => scope.workspaceRegistry.archivedSessionIds.includes(sessionId)

  /**
   * Pending-input check over one log read.
   * @param events - the target's events.
   * @returns true when either inbox queue holds a message.
   */
  const inboxPending = (events) => {
    const inbox = foldInbox(events)
    return inbox['next-turn'].length + inbox['next-step'].length > 0
  }

  /**
   * Decide whether a target can receive a dispatch right now.
   * @param sessionId - the target Session.
   * @param log - the target's log read for this decision.
   * @returns one state from decideTargetState.
   * @throws DispatchCoreError `unknown` when the inbox history does not fold.
   */
  const targetState = (sessionId, log) => {
    const live = scope.agents.get(sessionId)
    return decideTargetState({
      live: live !== undefined,
      status: live?.status,
      subagent: log.header?.parentSession !== undefined,
      archived: isArchived(sessionId),
      waitingUser: pendingUserWait(log.events),
      inboxPending: inboxPending(log.events),
    })
  }

  /**
   * Check that the caller is the shadow itself (identity check, not approval).
   * @param exec - the executing tool call.
   * @returns `{caller}`, or `{code, detail}` with code `not-shadow`.
   */
  const bind = (exec) => {
    const caller = exec.agent
    if (caller === undefined) return { code: REASON.notShadow, detail: 'the call has no agent' }
    const header = caller.session?.header
    if (header === undefined) return { code: REASON.notShadow, detail: 'the call has no session' }
    if (header.parentSession !== undefined) {
      return { code: REASON.notShadow, detail: 'a subagent cannot dispatch on the shadow\'s behalf' }
    }
    if (directoryKey(header.cwd) !== shadowDir) {
      return { code: REASON.notShadow, detail: `this Session (${String(header.cwd)}) is not the shadow` }
    }
    return { caller }
  }

  /**
   * Resolve the named workspace and check the named Session belongs to it.
   *
   * A missing Session and a Session that belongs elsewhere are different facts;
   * the caller distinguishes them with {@link classifyMiss}.
   * @param workspaceId - the workspace the caller named.
   * @param sessionId - the Session the caller named.
   * @returns `{workspace}`, or `{code, detail?, suggestion?, workspace?}`.
   */
  const resolveTarget = (workspaceId, sessionId) => {
    const workspace = scope.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      return { code: REASON.workspaceNotFound, detail: `no workspace "${workspaceId}" is registered` }
    }
    if (workspace.sessionIds.includes(sessionId)) return { workspace }
    const suggestion = sessionIdSuggestion(sessionId, workspace.sessionIds)
    if (suggestion !== undefined) return { code: REASON.sessionNotFound, suggestion, workspace }
    return { code: REASON.workspaceMismatch, detail: `Session "${sessionId}" is not a member of workspace "${workspaceId}"`, workspace }
  }

  /**
   * Turn a failed {@link resolveTarget} into one named refusal.
   *
   * Order: near-miss suggestion, unknown workspace, Session that does not exist
   * at all (probed by one log read), Session that exists elsewhere.
   * @param miss - the failed resolution.
   * @param sessionId - the Session the caller named.
   * @param signal - cancellation for the probe read.
   * @returns `{code, detail}`.
   */
  const classifyMiss = async (miss, sessionId, signal) => {
    if (miss.suggestion !== undefined) {
      return { code: REASON.sessionNotFound, detail: `no Session "${sessionId}"; did you mean "${miss.suggestion}"?` }
    }
    if (miss.code === REASON.workspaceNotFound) return { code: miss.code, detail: miss.detail }
    const probe = await readLogOrNull(sessionId, signal)
    if (probe === null) return { code: REASON.sessionNotFound, detail: `no Session "${sessionId}" exists` }
    return { code: miss.code, detail: miss.detail }
  }

  /**
   * Read the deployment default selection for an Agent with no request yet.
   * @returns the default selection, or null when the host exposes none.
   */
  const defaultSelection = () => {
    const current = get('agentDefaultModel')?.currentSelection?.()
    if (current === undefined || current === null) return null
    if (typeof current.provider !== 'string' || typeof current.model !== 'string') return null
    return {
      provider: current.provider,
      model: current.model,
      ...current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) },
    }
  }

  return {
    scope,
    contractProblems,
    readLog,
    readLogOrNull,
    isArchived,
    inboxPending,
    targetState,
    bind,
    resolveTarget,
    classifyMiss,
    defaultSelection,
  }
}
