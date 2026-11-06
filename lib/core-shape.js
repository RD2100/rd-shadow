/**
 * Runtime contract checks: does the running DSH still have the shapes this
 * plugin reads (docs/decisions.md ADR-013, docs/detailed-design.md §7)?
 *
 * Layer: core (pure). Imports: none.
 * Each check returns a list of problems (empty = fine). Checks are deliberately
 * minimal: they require only the fields the plugin actually reads, so a runtime
 * that adds fields still passes, and one that renames or drops a read field
 * fails loud instead of producing a wrong verdict.
 */

/** Cap on problems reported by one check; the first few name the drift. */
const PROBLEM_MAX = 5

/** Host methods the three tools call, by service. */
const TOOL_METHODS = {
  agents: ['get'],
  llm: ['resolveModelInfo'],
  sessionController: ['resolveAgent', 'selectModel'],
  sessionQuery: ['observeSession', 'listSessions', 'readTitleSnapshots'],
  workspaceRegistry: ['get', 'list'],
}

/** Host methods the host half calls, by service. */
const HOST_METHODS = {
  permissionPresets: ['current', 'set'],
  sessions: ['list'],
}

/**
 * Check that each named service exposes the named methods.
 * @param scope - injected services.
 * @param methods - service name -> method names.
 * @returns problems, e.g. `sessionQuery.observeSession is not a function`.
 */
function methodProblems(scope, methods) {
  const problems = []
  for (const [service, names] of Object.entries(methods)) {
    const value = scope?.[service]
    if (value === undefined || value === null) {
      problems.push(`${service} is missing`)
      continue
    }
    for (const name of names) if (typeof value[name] !== 'function') problems.push(`${service}.${name} is not a function`)
  }
  return problems.slice(0, PROBLEM_MAX)
}

/**
 * Service shape the tools entry depends on.
 * @param scope - the tools entry's injected host services.
 * @returns problems; `workspaceRegistry.archivedSessionIds` must also be an array.
 */
export function toolServiceProblems(scope) {
  const problems = methodProblems(scope, TOOL_METHODS)
  if (scope?.workspaceRegistry !== undefined && !Array.isArray(scope.workspaceRegistry.archivedSessionIds)) {
    problems.push('workspaceRegistry.archivedSessionIds is not an array')
  }
  return problems.slice(0, PROBLEM_MAX)
}

/**
 * Service shape the host half depends on.
 * @param scope - the host half's injected services.
 * @returns problems.
 */
export function hostServiceProblems(scope) {
  return methodProblems(scope, HOST_METHODS)
}

/**
 * Shape of one `observeSession` lease.
 * @param lease - the lease as returned by the host.
 * @returns problems.
 */
export function leaseProblems(lease) {
  if (lease === null || typeof lease !== 'object') return ['the session lease is not an object']
  const problems = []
  if (typeof lease.events?.[Symbol.iterator] !== 'function') problems.push('lease.events is not iterable')
  if (!Number.isSafeInteger(lease.cursor)) problems.push('lease.cursor is not an integer')
  if (lease.header === null || typeof lease.header !== 'object') problems.push('lease.header is not an object')
  if (!Number.isSafeInteger(lease.inheritedEventCount) || lease.inheritedEventCount < 0) {
    problems.push('lease.inheritedEventCount is not a non-negative integer')
  }
  return problems
}

/** Field checks for the event types the plugin folds; other types are ignored. */
const EVENT_RULES = {
  'agent/inbox/spliced': (data) => [
    typeof data?.target === 'string' || 'data.target is not a string',
    Number.isSafeInteger(data?.start) || 'data.start is not an integer',
    Array.isArray(data?.inserted) || 'data.inserted is not an array',
  ],
  'user/message': (data) => [typeof data?.id === 'string' || 'data.id is not a string'],
  'request/header': (data) => [
    (data?.header?.config !== null && typeof data?.header?.config === 'object') || 'data.header.config is not an object',
  ],
  'tool/call': (data) => [
    typeof data?.callId === 'string' || 'data.callId is not a string',
    typeof data?.name === 'string' || 'data.name is not a string',
  ],
  'assistant/message': (data) => [Array.isArray(data?.message?.content) || 'data.message.content is not an array'],
  'turn/end': (data) => [typeof data?.reason?.kind === 'string' || 'data.reason.kind is not a string'],
}

/**
 * Shape of the events the plugin folds.
 * @param events - a Session's events, oldest first.
 * @returns problems, each naming the seq and type, e.g. `#12 turn/end: data.reason.kind is not a string`.
 */
export function eventProblems(events) {
  const problems = []
  for (const event of events) {
    if (problems.length >= PROBLEM_MAX) break
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) {
      problems.push('an event has no string type or integer seq')
      continue
    }
    const rule = EVENT_RULES[event.type]
    if (rule === undefined) continue
    for (const verdict of rule(event.data)) if (verdict !== true) problems.push(`#${event.seq} ${event.type}: ${verdict}`)
  }
  return problems.slice(0, PROBLEM_MAX)
}
