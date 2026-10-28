/**
 * Agent-scoped tools entry for the shadow plugin.
 *
 * This row lives in the `shadow` agent preset (cordis.patch.yml), so the tools
 * exist only inside a shadow Session's agent scope; a global registration would
 * put them in every conversation. Two tools:
 *
 * - `shadow_inspect` reads one target Session without activating it.
 * - `shadow_dispatch` delivers one relay message to a target Session and
 *   reports what the target's log proves about that delivery.
 *
 * Every judgment lives in ./dispatch-core.js; this file supplies the effects
 * (observe, resolve, select, send) and maps outcomes onto tool results. The
 * dispatch state machine and its rejection codes are DISPATCH-SPEC.md §4.
 *
 * There is no approval gate of its own: the deployment's per-call reviewer
 * decides what may run (DESIGN §3.3). The only local check is the binding check
 * — the caller must be the shadow itself, not a subagent and not a Session
 * outside the shadow directory.
 *
 * `@deepseek-ai/dsh-tools` is resolved by the DSH loader's module registry, not
 * by npm: the package is deliberately absent from this package's dependencies so
 * a profile `pnpm install` never tries to fetch a second copy of a runtime-owned
 * package (DISPATCH-SPEC.md §12.1).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_SHADOW_DIR, directoryKey, expandShadowDir } from './shadow-dir.js'
import {
  CONTENT_MAX_LENGTH,
  DEFAULT_PROTECTED_PATHS,
  DISPATCH_TOOL,
  DispatchCoreError,
  INSPECT_PAGE_MAX,
  REASON,
  argumentsMatch,
  buildRelayMessage,
  currentSelection,
  decideTargetState,
  deliveryEvidence,
  deriveIdentity,
  deriveMessageId,
  findDispatchCall,
  foldInbox,
  inspectEgress,
  isReceivable,
  pendingUserWait,
  renderDispatchReceipt,
  renderInspection,
  renderTargets,
  selectionMismatch,
  sessionIdSuggestion,
  summarizeEvent,
  touchesProtected,
} from './dispatch-core.js'

/** Loader row name for this entry; the preset row references this subpath. */
export const name = 'dsh-plugin-shadow/tools'

/** The tool registry is the only agent-scoped service needed at load time. */
export const inject = ['tools']

/** Host services the tools read; host services need their own declared injection. */
const HOST_SERVICES = ['agents', 'llm', 'sessionController', 'sessionQuery', 'sessions', 'workspaceRegistry']

/** Session-query code for a Session absent from both the live table and persistence. */
const SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

/** Default page size for the inspection event read. */
const INSPECT_PAGE_DEFAULT = 20

/** Default Sessions listed per workspace by the target catalog. */
const TARGETS_PAGE_DEFAULT = 12

/** Cap on Sessions listed per workspace by the target catalog. */
const TARGETS_PAGE_MAX = 40

/**
 * Read a message from any thrown value for a receipt's reason line.
 * @param error - the caught value.
 * @returns the error message, or its string form.
 */
function messageOf(error) {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

/**
 * Read the stable code from any thrown value.
 * @param error - the caught value.
 * @returns the code when the value carries one, else the unknown code.
 */
function codeOf(error) {
  const code = error?.code
  return typeof code === 'string' && code.length > 0 ? code : REASON.unknown
}

/**
 * Register the shadow's model-facing tools for one agent scope.
 * @param ctx - agent-scoped tool registration context.
 * @param config - optional row config naming the shadow directory.
 * @returns nothing; registrations are disposed with the plugin fiber.
 */
export function apply(ctx, config) {
  const shadowDir = directoryKey(expandShadowDir(config?.shadowDir) ?? DEFAULT_SHADOW_DIR)
  /** Destinations this deployment sends to without asking; empty means ask always. */
  const egressAllowlist = Array.isArray(config?.egressAllowlist)
    ? config.egressAllowlist.filter((entry) => typeof entry === 'string')
    : []
  /** Path fragments whose mention marks the turn as carrying protected data. */
  const protectedPaths = Array.isArray(config?.protectedPaths)
    ? config.protectedPaths.filter((entry) => typeof entry === 'string')
    : DEFAULT_PROTECTED_PATHS

  ctx.inject(HOST_SERVICES, (scope) => {
    /** Per-target dispatch chains; the map's owner is this plugin instance. */
    const chains = new Map()
    /** Sessions whose current turn has touched protected data. */
    const tainted = new Set()

    /**
     * Ask before a shadow call reaches a host outside the allowlist.
     *
     * This is a rule, not a judgement: the destination either matches or it does
     * not, so the outcome is reproducible and testable with fake payloads. A turn
     * that read protected data loses the allowlist — where it may send says
     * nothing about what it is carrying — and the taint clears at the turn
     * boundary, so ordinary work stays quiet.
     *
     * The taint read and the destination rule share one try because both must
     * fail the same way: a guard that cannot answer refuses the call with its
     * cause. Silently passing on a broken check would turn a bug into a hole.
     * @param exec - the pending tool call.
     * @param next - the downstream chain.
     * @returns the downstream result, or a denial.
     */
    const guardEgress = async (exec, next) => {
      let verdict
      try {
        const sessionId = exec.agent?.session?.id
        if (typeof sessionId === 'string' && touchesProtected({ args: exec.arguments, protectedPaths }) !== undefined) {
          tainted.add(sessionId)
        }
        verdict = inspectEgress({
          toolName: exec.name,
          args: exec.arguments,
          allowlist: egressAllowlist,
          tainted: typeof sessionId === 'string' && tainted.has(sessionId),
        })
      } catch (error) {
        return {
          kind: 'deny',
          reason: `shadow: the outbound check itself failed (${messageOf(error)}), so the call was refused`,
        }
      }
      if (verdict === undefined) return next()
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) {
        // Fail closed: without a channel to ask, an unlisted destination is refused.
        return { kind: 'deny', reason: `shadow: ${verdict.reason}, and no approval channel is available` }
      }
      let outcome
      try {
        outcome = await approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: `shadow: ${verdict.reason}`,
          signal: exec.signal,
        })
      } catch (error) {
        return { kind: 'deny', reason: `shadow: could not ask about ${verdict.host}: ${messageOf(error)}` }
      }
      if (outcome === 'allowed-once') return next()
      return { kind: 'deny', reason: `shadow: sending to "${verdict.host}" was not approved` }
    }

    ctx.on('tools/pre-execute', guardEgress)

    // Taint is per turn: a boundary ends the window in which the turn's reads
    // could still be carried out.
    ctx.on('session/event', (subject, event) => {
      if (event?.type !== 'turn/end' && event?.type !== 'turn/start') return
      const id = subject?.id ?? subject?.header?.id
      if (typeof id === 'string') tainted.delete(id)
    })

    /**
     * Run one operation after every earlier operation for the same target.
     * @param sessionId - the target the chain belongs to.
     * @param operation - the work to run in order.
     * @returns the operation's own result or rejection.
     */
    const serialize = (sessionId, operation) => {
      const prior = chains.get(sessionId) ?? Promise.resolve()
      const next = prior.then(operation, operation)
      chains.set(sessionId, next.then(() => undefined, () => undefined))
      return next
    }

    /**
     * Read one Session's durable log without activating it.
     * @param sessionId - the Session to observe.
     * @param signal - cancellation for the read.
     * @returns header, events, inherited-event count, and last-committed cursor.
     */
    const readLog = async (sessionId, signal) => {
      const lease = await scope.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
      try {
        return {
          header: lease.header,
          events: [...lease.events],
          inheritedEventCount: lease.inheritedEventCount,
          cursor: lease.cursor,
          live: lease.source === 'live',
        }
      } finally {
        lease[Symbol.dispose]?.()
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
     * Decide whether a target can receive a dispatch right now.
     * @param sessionId - the target Session.
     * @param log - the target's log read for this decision.
     * @returns one state from {@link decideTargetState}.
     */
    const targetState = (sessionId, log) => {
      const live = scope.agents.get(sessionId)
      const inbox = foldInbox(log.events)
      return decideTargetState({
        live: live !== undefined,
        status: live?.status,
        subagent: log.header?.parentSession !== undefined,
        archived: scope.workspaceRegistry.archivedSessionIds.includes(sessionId),
        waitingUser: pendingUserWait(log.events),
        inboxPending: inbox['next-turn'].length + inbox['next-step'].length > 0,
      })
    }

    /**
     * Check that the caller is the shadow itself.
     * @param exec - the executing tool call.
     * @returns the calling Agent, or the rejection code and detail.
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
     * Build one rejection receipt.
     * @param code - one stable code from {@link REASON}.
     * @param detail - optional human-readable cause.
     * @returns the model-facing rejection receipt.
     */
    const reject = (code, detail) => ({
      status: 'rejected',
      selected: null,
      evidence: null,
      reason: detail === undefined ? code : `${code} (${detail})`,
    })

    /**
     * Verify the live target is exactly the Session this dispatch measured.
     * @param sessionId - the target Session id.
     * @param workspace - the workspace the target must belong to.
     * @param agent - the resolved live Agent.
     * @param fresh - a log read taken after resolution.
     * @returns ok, or the rejection code and detail.
     */
    const liveReady = (sessionId, workspace, agent, fresh) => {
      if (agent?.session?.id !== sessionId) {
        return { code: REASON.sessionDetached, detail: `the target resolved to "${String(agent?.session?.id)}"` }
      }
      if (scope.workspaceRegistry.archivedSessionIds.includes(sessionId)) {
        return { code: REASON.archived, detail: 'the target became archived' }
      }
      if (!workspace.sessionIds.includes(sessionId)) {
        return { code: REASON.workspaceMismatch, detail: 'the target left the workspace' }
      }
      if (agent.status !== 'idle') return { code: REASON.busy, detail: `the target is ${String(agent.status)}` }
      const inbox = foldInbox(fresh.events)
      if (inbox['next-turn'].length + inbox['next-step'].length > 0) {
        return { code: REASON.pending, detail: 'the target has pending input' }
      }
      if (agent.session.seq - 1 !== fresh.cursor) {
        return { code: REASON.sessionChanged, detail: `the target log advanced past ${String(fresh.cursor)}` }
      }
      return { ok: true }
    }

    /**
     * Resolve the named workspace and check the named Session belongs to it.
     *
     * A missing Session and a Session that belongs elsewhere are different
     * facts; the caller distinguishes them by probing the log afterwards, so this
     * check reports the membership verdict and, when the identifier looks like a
     * bare uuid, the exact id it probably meant.
     * @param workspaceId - the workspace the caller named.
     * @param sessionId - the Session the caller named.
     * @returns the workspace, or the rejection code and detail.
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
     * Read the deployment default selection for an Agent with no request yet.
     * @returns the default selection, or null when the host exposes none.
     */
    const defaultSelection = () => {
      const defaults = ctx.get('agentDefaultModel')
      const current = defaults?.currentSelection?.()
      if (current === undefined || current === null) return null
      if (typeof current.provider !== 'string' || typeof current.model !== 'string') return null
      return {
        provider: current.provider,
        model: current.model,
        ...current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) },
      }
    }

    /**
     * Deliver one relay message and report what the target's log proves.
     * @param args - validated tool arguments.
     * @param exec - the executing tool call.
     * @returns the delivery receipt.
     */
    const dispatch = async (args, exec) => {
      const signal = exec.signal
      const bound = bind(exec)
      if (bound.code !== undefined) return reject(bound.code, bound.detail)
      const caller = bound.caller
      const senderSessionId = caller.session.id

      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content.length === 0) return reject(REASON.invalidContent, 'content must not be empty')
      if (content.length > CONTENT_MAX_LENGTH) {
        return reject(REASON.invalidContent, `content exceeds ${String(CONTENT_MAX_LENGTH)} characters`)
      }

      const resolvedTarget = resolveTarget(args.workspaceId, args.sessionId)
      if (resolvedTarget.code !== undefined) {
        if (resolvedTarget.suggestion !== undefined) {
          return reject(REASON.sessionNotFound, `no Session "${args.sessionId}"; did you mean "${resolvedTarget.suggestion}"?`)
        }
        if (resolvedTarget.code === REASON.workspaceNotFound) return reject(resolvedTarget.code, resolvedTarget.detail)
        // A Session that exists elsewhere is refused as a mismatch; one that does
        // not exist at all is a different mistake and is named as such.
        const probe = await readLogOrNull(args.sessionId, signal)
        if (probe === null) return reject(REASON.sessionNotFound, `no Session "${args.sessionId}" exists`)
        return reject(resolvedTarget.code, resolvedTarget.detail)
      }
      const workspace = resolvedTarget.workspace

      const shadowLog = await readLog(senderSessionId, signal)
      const call = findDispatchCall({ events: shadowLog.events, callId: exec.callId })
      if (call === null) {
        throw new DispatchCoreError(REASON.unknown, `the executing call ${exec.callId} is not in this Session's log`)
      }
      if (!argumentsMatch(call.arguments, exec.arguments)) {
        return reject(REASON.identityConflict, 'the logged call does not carry these arguments')
      }
      const identity = deriveIdentity({ sessionId: senderSessionId, callId: exec.callId, kind: call.kind })

      const target = await readLogOrNull(args.sessionId, signal)
      if (target === null) return reject(REASON.sessionNotFound, `session "${args.sessionId}" has no log`)

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
        selected = currentSelection(target.events) ?? defaultSelection()
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

      const early = deliveryEvidence({ events: target.events, inheritedEventCount: target.inheritedEventCount, message })
      if (early !== null) {
        return { status: 'already-delivered', selected, evidence: early, target: targetRef, messageId }
      }

      const state = targetState(args.sessionId, target)
      if (!isReceivable(state)) return { ...reject(state, 'the target cannot receive work right now'), target: targetRef, messageId }

      const resolved = await scope.sessionController.resolveAgent(args.sessionId)
      if ('error' in resolved) {
        return { ...reject(codeOf(resolved.error), messageOf(resolved.error)), target: targetRef, messageId }
      }
      const agent = resolved.agent

      const fresh = await readLogOrNull(args.sessionId, signal)
      if (fresh === null) return { ...reject(REASON.sessionDetached, 'the target log disappeared'), target: targetRef, messageId }
      const ready = liveReady(args.sessionId, workspace, agent, fresh)
      if (ready.code !== undefined) return { ...reject(ready.code, ready.detail), target: targetRef, messageId }

      if (args.selection !== undefined) {
        const applied = await scope.sessionController.selectModel({
          sessionId: args.sessionId,
          provider: selected.provider,
          model: selected.model,
          ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
        })
        if ('error' in applied) {
          return { ...reject(codeOf(applied.error), messageOf(applied.error)), target: targetRef, messageId }
        }
      }

      const settled = await readLogOrNull(args.sessionId, signal)
      if (settled === null) return { ...reject(REASON.sessionDetached, 'the target log disappeared'), target: targetRef, messageId }
      const recheck = liveReady(args.sessionId, workspace, agent, settled)
      if (recheck.code !== undefined) return { ...reject(recheck.code, recheck.detail), target: targetRef, messageId }

      try {
        agent.send(message, 'next-turn', true)
      } catch (error) {
        return { ...reject(REASON.sessionDetached, messageOf(error)), target: targetRef, messageId }
      }

      try {
        const after = await readLogOrNull(args.sessionId, signal)
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
        return { status: 'unknown', selected, evidence: null, target: targetRef, messageId, reason: messageOf(error) }
      }
    }

    /**
     * Read one target's state and an optional event page.
     * @param args - validated tool arguments.
     * @param exec - the executing tool call.
     * @returns the model-facing inspection text.
     */
    const inspect = async (args, exec) => {
      const targetRef = `${args.workspaceId}/${args.sessionId}`
      const bound = bind(exec)
      if (bound.code !== undefined) {
        return renderInspection({ state: bound.code, target: targetRef, reason: bound.detail })
      }
      const target = resolveTarget(args.workspaceId, args.sessionId)
      if (target.code !== undefined) {
        if (target.suggestion !== undefined) {
          return renderInspection({
            state: REASON.sessionNotFound,
            target: targetRef,
            reason: `no Session "${args.sessionId}"; did you mean "${target.suggestion}"?`,
          })
        }
        if (target.code === REASON.workspaceNotFound) {
          return renderInspection({ state: target.code, target: targetRef, reason: target.detail })
        }
        const probe = await readLogOrNull(args.sessionId, exec.signal)
        if (probe === null) {
          return renderInspection({ state: REASON.sessionNotFound, target: targetRef, reason: `no Session "${args.sessionId}" exists` })
        }
        return renderInspection({ state: target.code, target: targetRef, reason: target.detail })
      }
      const log = await readLogOrNull(args.sessionId, exec.signal)
      if (log === null) {
        return renderInspection({ state: REASON.unknown, target: targetRef, reason: 'the Session has no readable log' })
      }
      let state
      let inbox
      try {
        state = targetState(args.sessionId, log)
        inbox = foldInbox(log.events)
      } catch (error) {
        return renderInspection({ state: REASON.unknown, target: targetRef, probed: true, cwd: log.header?.cwd, model: currentSelection(log.events), asOfSeq: log.cursor, reason: messageOf(error) })
      }
      const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : undefined
      const limit = typeof args.limit === 'number' ? args.limit : INSPECT_PAGE_DEFAULT
      const pageLimit = Math.min(Math.max(1, Math.trunc(limit)), INSPECT_PAGE_MAX)
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
        inboxPending: inbox['next-turn'].length + inbox['next-step'].length > 0,
        events,
        eventPage: matching === undefined ? undefined : { total: matching.length, afterSeq, lastSeq: log.cursor, limit: pageLimit },
      })
    }

    /**
     * List the workspaces and the Sessions a dispatch could address.
     * @param args - optional workspace filter and per-workspace page size.
     * @param exec - the executing tool call.
     * @returns the model-facing catalog text.
     */
    const targets = async (args, exec) => {
      const bound = bind(exec)
      if (bound.code !== undefined) {
        return [`shadow_targets -> ${bound.code}`, `reason: ${bound.detail}`].join('\n')
      }
      const registry = scope.workspaceRegistry
      let workspaces
      if (args.workspaceId === undefined) {
        workspaces = registry.list()
      } else {
        const named = registry.get(args.workspaceId)
        if (named === undefined) {
          return [`shadow_targets -> ${REASON.workspaceNotFound}`, `reason: no workspace "${args.workspaceId}" is registered`].join('\n')
        }
        workspaces = [named]
      }
      const limit = Math.min(
        Math.max(1, Math.trunc(typeof args.limit === 'number' ? args.limit : TARGETS_PAGE_DEFAULT)),
        TARGETS_PAGE_MAX,
      )
      const pages = workspaces.map((workspace) => {
        const ids = workspace.sessionIds
        return { workspace, ids: ids.slice(0, limit), omitted: Math.max(0, ids.length - limit) }
      })
      const wanted = [...new Set(pages.flatMap((page) => page.ids))]
      let records = new Map()
      if (wanted.length > 0) records = new Map((await scope.sessionQuery.listSessions(exec.signal)).map((record) => [record.header.id, record]))
      const titles = new Map()
      if (wanted.length > 0) {
        try {
          const snapshots = await scope.sessionQuery.readTitleSnapshots(wanted, exec.signal)
          for (const entry of snapshots) {
            // Each result is `{sessionId, status, value|reason}`: a rejected read
            // carries no header, and a fulfilled value holds the header plus a title
            // *snapshot* whose `.title` is the string.
            if (entry?.status !== 'fulfilled') continue
            const id = entry.value?.session?.id
            if (typeof id !== 'string') continue
            const title = entry.value.title?.title
            if (typeof title === 'string' && title.length > 0) titles.set(id, title)
          }
        } catch (error) {
          // A title is a convenience for choosing a target; a failed fold must not
          // hide the ids and states the caller actually needs.
          titles.clear()
        }
      }
      const archived = new Set(registry.archivedSessionIds)
      return renderTargets({
        workspaces: pages.map((page) => ({
          id: page.workspace.id,
          title: page.workspace.title,
          path: page.workspace.path,
          omitted: page.omitted,
          sessions: page.ids.map((id) => {
            const live = scope.agents.get(id)
            return {
              id,
              title: titles.get(id),
              state: live === undefined ? REASON.cold : live.status === 'running' ? REASON.busy : REASON.idle,
              archived: archived.has(id),
              subagent: records.get(id)?.header?.parentSession !== undefined,
            }
          }),
        })),
      })
    }

    ctx.tools.register(defineTool({
      name: DISPATCH_TOOL,
      description: 'Deliver one plain-text message to another Session on the user\'s behalf. The target\'s log records you as the sender. The target must be able to receive work right now (idle or asleep); call shadow_inspect first when unsure, because a busy or waiting target is refused rather than queued. Repeating the same call never delivers twice; to send again, call again. Asking for a model selection also saves it as the default for new requests. A result of unknown means the delivery may have happened: report it and verify with shadow_inspect instead of retrying.',
      parameters: {
        workspaceId: {
          type: 'string',
          required: true,
          description: 'Workspace id the target Session belongs to.',
        },
        sessionId: {
          type: 'string',
          required: true,
          description: 'Target Session id.',
        },
        content: {
          type: 'string',
          required: true,
          description: `Message text, plain text only, at most ${String(CONTENT_MAX_LENGTH)} characters.`,
        },
        selection: {
          type: 'object',
          additionalProperties: false,
          description: 'Optional model the target should run this message with. Omitting it leaves the target\'s current model unchanged.',
          properties: {
            provider: {
              type: 'string',
              required: true,
              description: 'Provider route id.',
            },
            model: {
              type: 'string',
              required: true,
              description: 'Model id.',
            },
            reasoningEffort: {
              type: 'string',
              description: 'Optional reasoning effort id.',
            },
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return renderDispatchReceipt(await serialize(args.sessionId, () => dispatch(args, exec)))
      },
    }))

    ctx.tools.register(defineTool({
      name: 'shadow_inspect',
      description: 'Read one Session\'s current state without activating it or sending anything: whether it can receive work right now (idle, cold, busy, waiting-user, pending, archived, subagent, unknown), its directory, its current model, and optionally the events after a sequence number. Use it to check a target before dispatching, or to verify what a target did after a delivery.',
      parameters: {
        workspaceId: {
          type: 'string',
          required: true,
          description: 'Workspace id the target Session belongs to.',
        },
        sessionId: {
          type: 'string',
          required: true,
          description: 'Target Session id.',
        },
        afterSeq: {
          type: 'number',
          description: 'Return only events with a greater sequence number; omit to return no events.',
        },
        limit: {
          type: 'number',
          description: `Maximum events in the page, default ${String(INSPECT_PAGE_DEFAULT)}, capped at ${String(INSPECT_PAGE_MAX)}.`,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return inspect(args, exec)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'shadow_targets',
      description: 'List the workspaces and Sessions that shadow_dispatch can address: each Session id, its live state (idle, cold, busy), and whether it is archived or belongs to a subagent. The shadow has no other way to learn a target id, so list first when the user names a project rather than a Session. States shown here are a snapshot; shadow_inspect reads one target exactly.',
      parameters: {
        workspaceId: {
          type: 'string',
          description: 'Narrow the listing to one workspace id; omit to list every workspace.',
        },
        limit: {
          type: 'number',
          description: `Maximum Sessions listed per workspace, default ${String(TARGETS_PAGE_DEFAULT)}, capped at ${String(TARGETS_PAGE_MAX)}.`,
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return targets(args, exec)
      },
    }))
  })
}
