/** Pure lifecycle call identity. New conversations never inherit the caller's preset. */
import { createHash } from 'node:crypto'
import { DispatchCoreError, REASON } from './core-contract.js'
import { findDispatchCall, argumentsMatch, deriveIdentity } from './core-identity.js'

export function managementIdentity({ events, callerId, args, exec, toolName }) {
  if (typeof exec.callId !== 'string' || exec.callId.length === 0) {
    throw new DispatchCoreError(REASON.identityConflict, 'missing-call-id')
  }
  const call = findDispatchCall({ events, callId: exec.callId, toolName })
  if (!call || !argumentsMatch(call.arguments, args) || !argumentsMatch(call.arguments, exec.arguments)) {
    throw new DispatchCoreError(REASON.identityConflict, 'logged-arguments-mismatch')
  }
  return deriveIdentity({ sessionId: callerId, callId: exec.callId, kind: call.kind })
}

export function managedSessionId(identity, workspaceId, title) {
  const hex = createHash('sha256').update([identity, workspaceId, title].join('\0')).digest('hex')
  return `session-${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
