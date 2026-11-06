/**
 * Compatibility barrel for the pure dispatch core.
 *
 * Layer: barrel. This file contains re-exports only (enforced by
 * tests/arch.test.mjs). New runtime code imports the core-* module that owns a
 * symbol directly; this barrel exists so tests and external readers that import
 * `./dispatch-core.js` keep one stable entry point.
 *
 * Owners (docs/detailed-design.md §2):
 * - core-contract.js   vocabulary, limits, error type
 * - core-identity.js   call anchoring, identity, message id, relay message
 * - core-log.js        log folds: selection, inbox, user waits, delivery evidence
 * - core-admission.js  target state decision, id suggestion
 * - core-render.js     model-facing text
 * - core-reply.js      what a target answered after one seq
 * - core-shape.js      runtime contract checks
 * - core-serial.js     per-key operation chains (not re-exported)
 *
 * The retired egress classifier (inspectEgress, touchesProtected, ...) was
 * removed in 0.12.0; the last version is at tag `archive/egress-classifier`.
 */

export {
  CONTENT_MAX_LENGTH,
  DISPATCH_TOOL,
  DispatchCoreError,
  INSPECT_PAGE_DEFAULT,
  INSPECT_PAGE_MAX,
  REASON,
  SESSION_ID_PREFIX,
  TARGETS_PAGE_DEFAULT,
  TARGETS_PAGE_MAX,
  REPLY_TEXT_MAX,
  RUNTIME_MISMATCH_HINT,
  VERIFIED_RUNTIME,
  codeOf,
  messageOf,
} from './core-contract.js'
export { argumentsMatch, buildRelayMessage, deriveIdentity, deriveMessageId, findDispatchCall } from './core-identity.js'
export { currentSelection, deliveryEvidence, foldInbox, pendingUserWait, selectionMismatch } from './core-log.js'
export { decideTargetState, isReceivable, sessionIdSuggestion } from './core-admission.js'
export { UNTRUSTED_LINE, renderDispatchReceipt, renderInspection, renderSelection, renderTargets, summarizeEvent } from './core-render.js'
export { collectReply } from './core-reply.js'
export { eventProblems, hostServiceProblems, leaseProblems, toolServiceProblems } from './core-shape.js'
