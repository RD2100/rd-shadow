/**
 * Stable vocabulary and limits shared by every shadow module.
 *
 * Layer: core (pure). Imports: none.
 * Everything the model can read verbatim lives here: tool names, rejection and
 * state codes, size limits. Changing a value here changes the model-facing
 * contract; record it in CHANGELOG and docs/detailed-design.md §5.
 */

/** Tool name whose calls this core anchors dispatch identities to. */
export const DISPATCH_TOOL = 'shadow_dispatch'

/** Maximum characters of one content part accepted from the model. */
export const CONTENT_MAX_LENGTH = 20000

/** Maximum events one inspection page returns. */
export const INSPECT_PAGE_MAX = 50

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

/** Prefix every Session id carries. */
export const SESSION_ID_PREFIX = 'session-'

/** Default page size for one inspection event read. */
export const INSPECT_PAGE_DEFAULT = 20

/** Default Sessions listed per workspace by the target catalog. */
export const TARGETS_PAGE_DEFAULT = 12

/** Cap on Sessions listed per workspace by the target catalog. */
export const TARGETS_PAGE_MAX = 40

/**
 * Read a message from any thrown value for a receipt's reason line.
 * @param error - the caught value.
 * @returns the error message, or its string form.
 */
export function messageOf(error) {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

/**
 * Read the stable code from any thrown value.
 * @param error - the caught value.
 * @returns the code when the value carries one, else the unknown code.
 */
export function codeOf(error) {
  const code = error?.code
  return typeof code === 'string' && code.length > 0 ? code : REASON.unknown
}
