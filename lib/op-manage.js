/** Shadow-only lifecycle operations. No message sending or model selection. */
import { DispatchCoreError, REASON } from './core-contract.js'
import { managementIdentity, managedSessionId } from './core-manage.js'

const key = value => typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : undefined
const rejected = reason => ({ status: 'rejected', reason })
const sameDirectory = (a,b) => key(a) !== undefined && key(a) === key(b)

async function authorize(host, args, exec, toolName) {
  const bound = host.bind(exec)
  if (bound.code) throw new DispatchCoreError(bound.code, bound.code)
  if (host.contractProblems.length) throw new DispatchCoreError(REASON.runtimeMismatch, REASON.runtimeMismatch)
  const callerId = bound.caller.session.id
  const log = await host.readLog(callerId, exec.signal)
  const identity = managementIdentity({ events: log.events, callerId, args, exec, toolName })
  return { caller: bound.caller, identity }
}

function validRoot(host, log, workspace, sessionId) {
  return log?.header?.id === sessionId && log.header.parentSession === undefined
    && sameDirectory(log.header.cwd, workspace.path) && workspace.sessionIds.includes(sessionId)
}

/** Translate only known domain failures before side effects; programming errors still throw. */
async function domainErrors(operation) {
  try { return await operation() } catch (error) {
    if (error instanceof DispatchCoreError) return rejected(error.code)
    throw error
  }
}

export async function createSession(host, args, exec) {
  return domainErrors(async () => {
    const { caller, identity } = await authorize(host, args, exec, 'shadow_create')
    const workspace = host.scope.workspaceRegistry.get(args.workspaceId)
    if (!workspace) return rejected(REASON.workspaceNotFound)
    if (sameDirectory(workspace.path, caller.session.header.cwd)) return rejected('shadow-workspace')
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title || title.length > 120) return rejected('invalid-title')
    const commands = host.scope.sessionController.commands
    if (typeof commands?.create !== 'function' || typeof commands?.rename !== 'function') return rejected(REASON.runtimeMismatch)
    const sessionId = managedSessionId(identity, args.workspaceId, title)
    const receipt = { workspaceId: args.workspaceId, sessionId }
    const old = await host.readLogOrNull(sessionId, exec.signal)
    if (old) {
      if (!validRoot(host, old, workspace, sessionId)) return { ...receipt, ...rejected(REASON.identityConflict) }
      return { ...receipt, status: 'already-created', archived: host.isArchived(sessionId) }
    }
    // Once create has started it may have durable effects even when the promise rejects.
    let created
    try { created = await commands.create({ workspaceId: args.workspaceId, sessionId, agentPreset: 'standard' }) }
    catch { return { ...receipt, status: 'unknown', reason: 'create-unconfirmed' } }
    if (created?.sessionId !== sessionId) {
      return { ...receipt, status: 'unknown', reason: 'created-identity-mismatch',
        ...(typeof created?.sessionId === 'string' ? { observedSessionId: created.sessionId } : {}) }
    }
    try {
      const log = await host.readLogOrNull(sessionId, exec.signal)
      if (!validRoot(host, log, workspace, sessionId) || created.agentPreset !== 'standard') {
        return { ...receipt, status: 'unknown', reason: 'created-session-unconfirmed' }
      }
      const renamed = await commands.rename({ sessionId, title })
      if (renamed?.title !== title) return { ...receipt, status: 'partial', reason: 'title-unconfirmed' }
    } catch { return { ...receipt, status: 'partial', reason: 'title-or-readback-unconfirmed' } }
    return { ...receipt, status: 'created', title, preset: 'standard' }
  })
}

export async function archiveSession(host, args, exec) {
  return domainErrors(async () => {
    const { caller } = await authorize(host, args, exec, 'shadow_archive')
    if (args.confirmed !== true) return rejected('confirmation-required')
    if (args.sessionId === caller.session.id) return rejected('self')
    const target = host.resolveTarget(args.workspaceId, args.sessionId)
    if (target.code) return rejected(target.code)
    if (sameDirectory(target.workspace.path, caller.session.header.cwd)) return rejected('shadow-workspace')
    if (typeof host.scope.workspaceRegistry.archiveSession !== 'function') return rejected(REASON.runtimeMismatch)
    const log = await host.readLogOrNull(args.sessionId, exec.signal)
    if (!log) return rejected(REASON.sessionNotFound)
    if (!validRoot(host, log, target.workspace, args.sessionId)) return rejected(log.header?.parentSession !== undefined ? 'subagent' : REASON.workspaceMismatch)
    const receipt = { workspaceId: args.workspaceId, sessionId: args.sessionId }
    if (host.isArchived(args.sessionId)) return { ...receipt, status: 'already-archived' }
    const state = host.targetState(args.sessionId, log)
    if (state !== REASON.idle && state !== REASON.cold) return rejected(state)
    try {
      await host.scope.workspaceRegistry.archiveSession(args.sessionId)
    } catch (error) {
      if (error?.name === 'WorkspaceActiveSessionError' || error?.code === 'WORKSPACE_ACTIVE_SESSION' || error?.code === 'workspace/session-active') return rejected('busy')
      return { ...receipt, status: 'unknown', reason: 'archive-unconfirmed' }
    }
    return host.isArchived(args.sessionId)
      ? { ...receipt, status: 'archived' }
      : { ...receipt, status: 'unknown', reason: 'archive-unconfirmed' }
  })
}
