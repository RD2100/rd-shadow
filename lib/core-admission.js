/**
 * Admission: whether a target can receive a dispatch right now, and the exact
 * id a near-miss identifier probably meant.
 *
 * Layer: core (pure). Imports: ./core-contract.js.
 * The state priority order is a contract; see docs/detailed-design.md §3.4.
 */

import { REASON, SESSION_ID_PREFIX } from './core-contract.js'

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
