/**
 * Offline host simulator for the shadow plugin's tools entry.
 *
 * Loads the REAL lib/tools.js (with @deepseek-ai/dsh-tools mapped to a
 * validation stub) and drives both tools against a fake host: sessions, live
 * agents, workspaces, session-query leases, and a session controller. This
 * verifies the whole dispatch state machine — binding, membership, identity,
 * idempotency, admission, receipts — without a DSH restart.
 */

import assert from 'node:assert/strict'
import { foldInbox } from '../lib/dispatch-core.js'

/** Tools entry under test; the deployed profile copy is exercised by overriding this. */
const TOOLS_URL = process.env.SHADOW_TOOLS ?? new URL('../lib/tools.js', import.meta.url).href
const toolsModule = await import(TOOLS_URL)
console.log(`tools entry: ${TOOLS_URL}`)

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}

const SHADOW_DIR = 'D:\\DSH\\shadow'

/** One durable Session log. */
class FakeSession {
  /**
   * @param id - session id.
   * @param cwd - creation directory.
   * @param options - extra header fields.
   */
  constructor(id, cwd, options = {}) {
    this.id = id
    this.header = { id, cwd, ...options }
    this.events = []
  }

  /** Next sequence number. */
  get seq() {
    return this.events.length === 0 ? 0 : this.events.at(-1).seq + 1
  }

  /**
   * Append one event.
   * @param type - event type.
   * @param data - event payload.
   * @returns the appended event.
   */
  append(type, data) {
    const event = { type, seq: this.seq, time: this.events.length, data }
    this.events.push(event)
    return event
  }
}

/**
 * Build one isolated fake host world.
 * @returns the world with its services and helpers.
 */
function makeWorld() {
  const sessions = new Map()
  const workspaces = new Map()
  const live = new Map()
  const archived = []
  const selections = new Map()

  const world = {
    sessions,
    workspaces,
    live,
    archived,
    /** Deployment default selection the host exposes; null means none. */
    defaultModel: { provider: 'dp', model: 'dm' },
    /** When set, a send is admitted inside the same call with this request config. */
    autoAdmit: null,
    /** Register a workspace over an explicit member list. */
    addWorkspace(id, memberIds, options = {}) {
      workspaces.set(id, {
        id,
        title: options.title ?? id,
        path: options.path ?? 'D:\\work\\proj',
        get sessionIds() {
          return memberIds.filter((sessionId) => sessions.has(sessionId))
        },
      })
    },
    /** Create one Session log. */
    addSession(id, cwd, options) {
      const session = new FakeSession(id, cwd, options)
      sessions.set(id, session)
      return session
    },
    /** Mark one Session live with an idle agent. */
    goLive(id, status = 'idle') {
      const session = sessions.get(id)
      const agent = {
        session,
        status,
        send(message, target) {
          const queue = foldInbox(session.events)[target]
          session.append('agent/inbox/spliced', { target, start: queue.length, removedCount: 0, inserted: [message] })
          // A fast driver admits the message inside the same dispatch when the
          // scenario asks for it; otherwise the message stays pending.
          if (world.autoAdmit !== null) {
            session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
            session.append('user/message', message)
            session.append('request/header', { header: { config: world.autoAdmit } })
          }
        },
      }
      live.set(id, agent)
      return agent
    },
    /** Simulate the driver admitting the pending message into a turn. */
    admit(id, config) {
      const session = sessions.get(id)
      const pending = foldInbox(session.events)['next-turn'][0]
      if (pending === undefined) return
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      session.append('user/message', pending)
      session.append('request/header', { header: { config } })
    },
    /** Archive one Session id. */
    archive(id) {
      archived.push(id)
    },
    /** The host services object handed to the plugin's injection callback. */    services() {
      return {
        agents: {
          get: (id) => live.get(id),
        },
        sessions: {
          get: (id) => sessions.get(id),
          list: () => [...sessions.values()],
        },
        workspaceRegistry: {
          get: (id) => workspaces.get(id),
          list: () => [...workspaces.values()],
          get archivedSessionIds() {
            return archived
          },
        },
        llm: {
          async resolveModelInfo(provider, model) {
            if (model === 'missing') {
              const error = new Error(`unknown model "${provider}/${model}"`)
              error.code = 'INVALID_MODEL_INFO'
              throw error
            }
            return { provider, id: model, name: model }
          },
        },
        sessionQuery: {
          async listSessions() {
            return [...sessions.values()].map((session) => ({ header: session.header, live: live.has(session.id), persisted: true }))
          },
          async readTitleSnapshots(ids) {
            // Mirrors the real contract: one `{sessionId, status, value|reason}` per
            // requested id, where a fulfilled value holds the header plus a title
            // snapshot object. Ids beginning with "unreadable-" model a failed read.
            return ids.map((id) => id.startsWith('unreadable-') || !sessions.has(id)
              ? { sessionId: id, status: 'rejected', reason: new Error('unreadable') }
              : {
                sessionId: id,
                status: 'fulfilled',
                value: {
                  session: sessions.get(id).header,
                  title: { title: `title of ${id}`, messageSeqs: [], source: 'generated', eventSeq: 0, updatedAt: 0 },
                },
              })
          },
          async observeSession(sessionId) {
            const session = sessions.get(sessionId)
            if (session === undefined) {
              const error = new Error(`session "${sessionId}" not found`)
              error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
              throw error
            }
            const events = session.events.map((event) => ({ ...event }))
            return {
              source: live.has(sessionId) ? 'live' : 'prepared',
              header: session.header,
              inheritedEventCount: 0,
              events,
              cursor: events.length === 0 ? -1 : events.at(-1).seq,
              retain() {
                return this
              },
              [Symbol.dispose]() {},
            }
          },
        },
        sessionController: {
          async resolveAgent(sessionId) {
            if (!sessions.has(sessionId)) {
              return { error: { code: 'session/not-found', message: `session "${sessionId}" not found` } }
            }
            if (archived.includes(sessionId)) {
              return { error: { code: 'session/not-found', message: `session "${sessionId}" is archived` } }
            }
            return { agent: live.get(sessionId) ?? world.goLive(sessionId) }
          },
          async selectModel(request) {
            if (!sessions.has(request.sessionId)) {
              return { error: { code: 'session/not-found', message: 'no session' } }
            }
            const selection = {
              provider: request.provider,
              model: request.model,
              ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
            }
            sessions.get(request.sessionId).append('model/selection', selection)
            selections.set(request.sessionId, selection)
            return { selection }
          },
        },
      }
    },
  }
  return world
}

/**
 * Install the plugin over one world and return its registered tools.
 * @param world - the fake host.
 * @returns the tools by name.
 */
function mount(world) {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return world.defaultModel === null ? undefined : { currentSelection: () => world.defaultModel }
      }
      return undefined
    },
    inject(services, callback) {
      const scope = world.services()
      for (const service of services) if (scope[service] === undefined) throw new Error(`missing service: ${service}`)
      callback(scope)
    },
  }
  toolsModule.apply(ctx, { shadowDir: SHADOW_DIR })
  return new Map(registered.map((definition) => [definition.name, definition]))
}

/**
 * Build the standard two-session world: a shadow and one project target.
 * @param options - target cwd and whether the target is live.
 * @returns the world plus the caller execution for a given call id.
 */
function scenario(options = {}) {
  const world = makeWorld()
  const shadow = world.addSession('shadow-1', SHADOW_DIR)
  const target = world.addSession('target-1', options.targetCwd ?? 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1'])
  if (options.targetLive) world.goLive('target-1', options.targetStatus)
  const tools = mount(world)
  const caller = world.goLive('shadow-1')
  /** Record one durable dispatch call on the shadow log. */
  const recordCall = (callId, args) => {
    shadow.append('tool/call', { turn: 1, step: 0, callId, name: 'shadow_dispatch', arguments: JSON.stringify(args) })
    return { agent: caller, callId, arguments: args, signal: new AbortController().signal }
  }
  return { world, shadow, target, tools, caller, recordCall }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

await check('registers both tools with valid authored schemas', async () => {
  const { tools } = scenario()
  assert.deepEqual([...tools.keys()].sort(), ['shadow_dispatch', 'shadow_inspect', 'shadow_targets'])
  assert.equal(toolsModule.name, 'dsh-plugin-shadow/tools')
  assert.deepEqual(toolsModule.inject, ['tools'])
})

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

await check('delivers to a cold target and reports acceptance', async () => {
  const { world, target, tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'check the build' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> accepted/)
  assert.match(text, /target: w1\/target-1/)
  assert.match(text, /message: shadow-message-[0-9a-f]{64}/)
  // The target log holds exactly one delivery carrying the shadow as sender.
  const spliced = target.events.filter((event) => event.type === 'agent/inbox/spliced')
  assert.equal(spliced.length, 1)
  const message = spliced[0].data.inserted[0]
  assert.deepEqual(message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'shadow-1' })
  assert.equal(message.content[0].text, 'check the build')
  // The cold target was resumed, not left cold.
  assert.ok(world.live.has('target-1'))
})

await check('a replayed call is already-delivered and never inserts twice', async () => {
  const { target, tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'check the build' }
  const exec = recordCall('call-1', args)
  await tools.get('shadow_dispatch').execute(args, exec)
  const second = await tools.get('shadow_dispatch').execute(args, exec)
  assert.match(second, /^shadow_dispatch -> already-delivered/)
  assert.equal(target.events.filter((event) => event.type === 'agent/inbox/spliced').length, 1)
})

await check('a new call with identical content is a new delivery', async () => {
  const { world, target, tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'same words', selection: { provider: 'p', model: 'm' } }
  const first = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(first, /^shadow_dispatch -> accepted/)
  const idOf = (text) => /message: (\S+)/.exec(text)[1]
  // Drain the first delivery so the target is receivable again.
  world.admit('target-1', { provider: 'p', model: 'm' })
  const second = await tools.get('shadow_dispatch').execute(args, recordCall('call-2', args))
  assert.match(second, /^shadow_dispatch -> accepted/)
  assert.notEqual(idOf(second), idOf(first))
})

await check('a busy target is refused with its state', async () => {
  const { tools, recordCall } = scenario({ targetLive: true, targetStatus: 'running' })
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> rejected/)
  assert.match(text, /reason: busy/)
})

await check('an archived target is refused as archived', async () => {
  const { world, tools, recordCall } = scenario()
  world.archive('target-1')
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: archived/)
})

await check('a target outside the named workspace is refused', async () => {
  const { world, tools, recordCall } = scenario()
  world.addSession('other', 'D:\\elsewhere')
  world.addWorkspace('w2', ['other'])
  const args = { workspaceId: 'w2', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: workspace-session-mismatch/)
})

await check('an unknown workspace is refused as workspace-not-found', async () => {
  const { tools, recordCall } = scenario()
  const args = { workspaceId: 'nope', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: workspace-not-found/)
})

await check('a bare uuid is refused with the exact id it meant', async () => {
  const { world, tools, recordCall } = scenario()
  world.addSession('session-scratch-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1', 'session-scratch-1'])
  const args = { workspaceId: 'w1', sessionId: 'scratch-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: session-not-found/)
  assert.match(text, /did you mean "session-scratch-1"\?/)
})

await check('a Session that exists but belongs elsewhere stays a mismatch', async () => {
  const { world, tools, recordCall } = scenario()
  world.addSession('stray-1', 'D:\\elsewhere')
  const args = { workspaceId: 'w1', sessionId: 'stray-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: workspace-session-mismatch/)
})

await check('a Session that does not exist at all is session-not-found', async () => {
  const { tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'session-ghost-0000', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: session-not-found/)
  assert.match(text, /no Session "session-ghost-0000" exists/)
})

await check('a caller outside the shadow directory is refused', async () => {
  const world = makeWorld()
  const impostor = world.addSession('plain-1', 'D:\\work\\proj')
  const target = world.addSession('target-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['plain-1', 'target-1'])
  const tools = mount(world)
  const caller = world.goLive('plain-1')
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  impostor.append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'shadow_dispatch', arguments: JSON.stringify(args) })
  const text = await tools.get('shadow_dispatch').execute(args, { agent: caller, callId: 'call-1', arguments: args, signal: new AbortController().signal })
  assert.match(text, /reason: not-shadow/)
  assert.equal(target.events.filter((event) => event.type === 'agent/inbox/spliced').length, 0)
})

await check('a subagent caller is refused', async () => {
  const world = makeWorld()
  const child = world.addSession('child-1', SHADOW_DIR, { parentSession: 'shadow-1' })
  world.addSession('shadow-1', SHADOW_DIR)
  world.addSession('target-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1'])
  const tools = mount(world)
  const caller = world.goLive('child-1')
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  child.append('tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'shadow_dispatch', arguments: JSON.stringify(args) })
  const text = await tools.get('shadow_dispatch').execute(args, { agent: caller, callId: 'call-1', arguments: args, signal: new AbortController().signal })
  assert.match(text, /reason: not-shadow/)
})

await check('empty content is refused before any read', async () => {
  const { tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: '   ' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: invalid-content/)
})

await check('oversized content is refused', async () => {
  const { tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'x'.repeat(20001) }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: invalid-content/)
})

await check('logged arguments that differ from the execution are refused', async () => {
  const { tools, recordCall } = scenario()
  const logged = { workspaceId: 'w1', sessionId: 'target-1', content: 'logged text' }
  const exec = recordCall('call-1', logged)
  // The execution claims different arguments than the durable call recorded.
  const forged = { ...exec, arguments: { ...logged, content: 'different text' } }
  const text = await tools.get('shadow_dispatch').execute(forged.arguments, forged)
  assert.match(text, /reason: identity-conflict/)
})

await check('an unknown selected model is refused', async () => {
  const { target, tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'missing' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: model-unavailable/)
  assert.equal(target.events.filter((event) => event.type === 'agent/inbox/spliced').length, 0)
})

await check('omitted selection falls back to the deployment default', async () => {
  const { tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> accepted/)
  assert.match(text, /selected: dp\/dm/)
})

await check('omitted selection with no target model and no default is refused', async () => {
  const { world, tools, recordCall } = scenario()
  world.defaultModel = null
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello' }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: model-unavailable/)
  assert.match(text, /pass selection explicitly/)
})

await check('an explicit selection is applied and reported', async () => {
  const { target, tools, recordCall } = scenario()
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm2', reasoningEffort: 'high' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> accepted/)
  assert.match(text, /selected: p\/m2\/high/)
  assert.ok(target.events.some((event) => event.type === 'model/selection' && event.data.model === 'm2'))
})

await check('a target that ran another model is reported as a mismatch', async () => {
  const { world, tools, recordCall } = scenario()
  world.autoAdmit = { provider: 'p', model: 'other' }
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm2' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> durable/)
  assert.match(text, /mismatch: the target ran p\/other; it was not switched back/)
})

await check('a delivered and admitted message reports durable', async () => {
  const { world, tools, recordCall } = scenario()
  world.autoAdmit = { provider: 'p', model: 'm' }
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /^shadow_dispatch -> durable/)
  assert.match(text, /evidence: inbox@\d+ user@\d+ execution@\d+ settled=false/)
})

await check('a replay after admission stays already-delivered', async () => {
  const { world, tools, recordCall } = scenario()
  world.autoAdmit = { provider: 'p', model: 'm' }
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm' } }
  const exec = recordCall('call-1', args)
  assert.match(await tools.get('shadow_dispatch').execute(args, exec), /^shadow_dispatch -> durable/)
  const replay = await tools.get('shadow_dispatch').execute(args, exec)
  assert.match(replay, /^shadow_dispatch -> already-delivered/)
  assert.match(replay, /user@\d+/)
})

await check('a target with pending input is refused as pending', async () => {
  const { world, target, tools, recordCall } = scenario()
  target.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: 'earlier', role: 'user', content: [], source: { kind: 'user-rpc' } }] })
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: pending/)
  assert.equal(world.live.has('target-1'), false)
})

await check('a target waiting on the user is refused as waiting-user', async () => {
  const { target, tools, recordCall } = scenario()
  target.append('approval/asked', { id: 'a1', toolName: 'delete' })
  const args = { workspaceId: 'w1', sessionId: 'target-1', content: 'hello', selection: { provider: 'p', model: 'm' } }
  const text = await tools.get('shadow_dispatch').execute(args, recordCall('call-1', args))
  assert.match(text, /reason: waiting-user/)
})

await check('concurrent dispatches to one target serialize', async () => {
  const { target, tools, recordCall } = scenario()
  const first = { workspaceId: 'w1', sessionId: 'target-1', content: 'first', selection: { provider: 'p', model: 'm' } }
  const second = { workspaceId: 'w1', sessionId: 'target-1', content: 'second', selection: { provider: 'p', model: 'm' } }
  const [a, b] = await Promise.all([
    tools.get('shadow_dispatch').execute(first, recordCall('call-1', first)),
    tools.get('shadow_dispatch').execute(second, recordCall('call-2', second)),
  ])
  const statuses = [a, b].map((text) => /^shadow_dispatch -> (\S+)/.exec(text)[1])
  assert.deepEqual(statuses.sort(), ['accepted', 'rejected'])
  assert.equal(target.events.filter((event) => event.type === 'agent/inbox/spliced').length, 1)
})

/* ------------------------------------------------------------------ */
/* Inspection                                                          */
/* ------------------------------------------------------------------ */

await check('inspects an idle live target', async () => {
  const { world, tools } = scenario({ targetLive: true })
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w1', sessionId: 'target-1' }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  assert.match(text, /^shadow_inspect -> idle/)
  assert.match(text, /cwd: D:\\work\\proj/)
  assert.match(text, /asOfSeq: -1/)
})

await check('inspects a cold target without activating it', async () => {
  const { world, tools } = scenario()
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w1', sessionId: 'target-1' }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  assert.match(text, /^shadow_inspect -> cold/)
  assert.equal(world.live.has('target-1'), false)
})

await check('inspection reports a missing Session as session-not-found', async () => {
  const { world, tools } = scenario()
  world.addWorkspace('w3', ['ghost'])
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w3', sessionId: 'ghost' }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  // 'ghost' is not a registered Session, so it is not a workspace member either.
  assert.match(text, /^shadow_inspect -> session-not-found/)
  assert.match(text, /no Session "ghost" exists/)
  assert.doesNotMatch(text, /cwd:/)
})

await check('inspection suggests the exact id for a bare uuid', async () => {
  const { world, tools } = scenario()
  world.addSession('session-scratch-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1', 'session-scratch-1'])
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w1', sessionId: 'scratch-1' }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  assert.match(text, /^shadow_inspect -> session-not-found/)
  assert.match(text, /did you mean "session-scratch-1"\?/)
})

await check('inspection reports an unknown workspace', async () => {
  const { world, tools } = scenario()
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'nope', sessionId: 'target-1' }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  assert.match(text, /^shadow_inspect -> workspace-not-found/)
})

await check('inspection pages events after a sequence', async () => {
  const { world, target, tools } = scenario()
  target.append('user/message', { id: 'u1', content: [], source: { kind: 'user-rpc' } })
  target.append('assistant/message', { message: { id: 'a1', content: [] } })
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w1', sessionId: 'target-1', afterSeq: -1, limit: 10 }, { agent: world.live.get('shadow-1'), signal: new AbortController().signal })
  assert.match(text, /events \(2 of 2 after seq -1; last seq is 1\):/)
  assert.match(text, /#0 user\/message/)
  assert.match(text, /#1 assistant\/message/)
})

await check('inspection refuses a non-shadow caller', async () => {
  const world = makeWorld()
  world.addSession('plain-1', 'D:\\work\\proj')
  world.addSession('target-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1'])
  const tools = mount(world)
  const caller = world.goLive('plain-1')
  const text = await tools.get('shadow_inspect').execute({ workspaceId: 'w1', sessionId: 'target-1' }, { agent: caller, signal: new AbortController().signal })
  assert.match(text, /^shadow_inspect -> not-shadow/)
})

/* ------------------------------------------------------------------ */
/* Target catalog                                                      */
/* ------------------------------------------------------------------ */

await check('catalogs workspaces with session ids, states, and markers', async () => {
  const { world, tools, caller } = scenario({ targetLive: true })
  world.addSession('cold-1', 'D:\\work\\proj')
  world.addSession('gone-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1', 'cold-1', 'gone-1'])
  world.archive('gone-1')
  const text = await tools.get('shadow_targets').execute({}, { agent: caller, signal: new AbortController().signal })
  assert.match(text, /^shadow_targets -> \d+ workspaces, \d+ sessions shown/)
  assert.match(text, /workspace w1 "/)
  assert.match(text, /session-target-1|target-1 {2}idle/)
  assert.match(text, /cold-1 {2}cold/)
  assert.match(text, /gone-1 {2}cold archived/)
  assert.match(text, /read one target exactly with shadow_inspect/)
  // Titles come from the snapshot object, not the whole snapshot.
  assert.match(text, /"title of target-1"/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

await check('catalog keeps other titles when one session read is rejected', async () => {
  const { world, tools, caller } = scenario()
  // A member whose title fold rejects: only that row loses its title.
  world.addSession('unreadable-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['target-1', 'unreadable-1'])
  const text = await tools.get('shadow_targets').execute({ workspaceId: 'w1' }, { agent: caller, signal: new AbortController().signal })
  assert.match(text, /"title of target-1"/)
  assert.match(text, /unreadable-1 {2}cold {2}\(untitled\)/)
})

await check('catalog narrows to one workspace and reports an unknown one', async () => {
  const { tools, caller } = scenario()
  const one = await tools.get('shadow_targets').execute({ workspaceId: 'w1' }, { agent: caller, signal: new AbortController().signal })
  assert.match(one, /^shadow_targets -> 1 workspaces/)
  const missing = await tools.get('shadow_targets').execute({ workspaceId: 'nope' }, { agent: caller, signal: new AbortController().signal })
  assert.match(missing, /^shadow_targets -> workspace-not-found/)
})

await check('catalog pages oversized workspaces and says so', async () => {
  const { world, tools, caller } = scenario()
  const members = ['target-1']
  for (let i = 0; i < 5; i += 1) {
    world.addSession(`extra-${i}`, 'D:\\work\\proj')
    members.push(`extra-${i}`)
  }
  world.addWorkspace('w1', members)
  const text = await tools.get('shadow_targets').execute({ workspaceId: 'w1', limit: 2 }, { agent: caller, signal: new AbortController().signal })
  assert.match(text, /\(4 more: raise limit to see them\)/)
})

await check('catalog refuses a non-shadow caller', async () => {
  const world = makeWorld()
  world.addSession('plain-1', 'D:\\work\\proj')
  world.addWorkspace('w1', ['plain-1'])
  const tools = mount(world)
  const caller = world.goLive('plain-1')
  const text = await tools.get('shadow_targets').execute({}, { agent: caller, signal: new AbortController().signal })
  assert.match(text, /^shadow_targets -> not-shadow/)
})

console.log(`tools integration sim: ${passed} scenarios passed`)
