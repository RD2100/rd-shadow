/**
 * Checks for the host half's startup preflight.
 *
 * The preflight exists so a mis-installed runtime fails visibly: a shadow whose
 * tools silently do not work is worse than one that refuses to start. These
 * checks drive `apply` with a fake context and assert what it reports.
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { apply } from '../lib/index.js'

const { check, todo, done } = suite('host-preflight')

/**
 * Build the minimal host context `apply` needs.
 * @param options - which services exist, whether sessions are listed, and how the
 *   one listed session reports its recorded presets.
 * @returns the fake context plus the collected log lines and applied presets.
 */
function makeCtx(options = {}) {
  const services = options.services ?? ['permissionPresets', 'sessions']
  const lines = []
  const applied = []
  /** Registration and log events in call order, to prove what happens first. */
  const order = []
  /** How many times the catalog was read; the mount read precedes the pins. */
  let nameReads = 0
  const events = options.recordedPreset === false ? [] : [{ type: 'permission/preset', data: { preset: 'workspace-write' } }]
  const sessions = options.sessions ?? [{
    id: 'shadow-1',
    header: { cwd: 'D:\\work\\shadow' },
    snapshotEvents: () => (options.unreadableLog === true ? throwUnreadable() : events),
  }]
  const ctx = {
    logger: {
      info: (message) => { lines.push(`info ${message}`); order.push(`info:${message}`) },
      warn: (message) => { lines.push(`warn ${message}`); order.push(`warn:${message}`) },
    },
    get: (name) => (services.includes(name) ? { name } : undefined),
    inject: (required, callback) => {
      const scope = {
        logger: ctx.logger,
        on: (event) => order.push(`on:${event}`),
        permissionPresets: {
          get names() {
            if (options.catalogThrows !== undefined) throw new Error(options.catalogThrows)
            // The mount read can precede the reviewer plugin's registration;
            // every later read (each pin) sees the catalog as it stands then.
            if (options.presetNamesAfter !== undefined && nameReads++ > 0) return options.presetNamesAfter
            return options.presetNames ?? ['auto', 'danger-full-access']
          },
          current: () => options.currentPreset ?? 'workspace-write',
          set: (session, target) => applied.push(`${session.id}:${target}`),
        },
        sessions: { list: () => sessions },
      }
      for (const name of required) if (scope[name] === undefined) throw new Error(`missing ${name}`)
      callback(scope)
    },
  }
  return { ctx, lines, applied, order }
}

/** A log accessor that fails, to prove the fallback keeps the user's choice. */
function throwUnreadable() {
  throw new Error('log unavailable')
}

check('TC-HOST-001', 'names the effective directory at startup', () => {
  const { ctx, lines } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.includes('shadow: directory D:\\work\\shadow')), lines.join('\n'))
})

check('TC-HOST-002', 'a fully equipped runtime reports no missing service', () => {
  const { ctx, lines } = makeCtx({
    services: ['permissionPresets', 'sessions', 'agents', 'llm', 'sessionController', 'sessionQuery', 'tools', 'workspaceRegistry'],
  })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(lines.filter((line) => line.startsWith('warn')), [], lines.join('\n'))
})

check('TC-HOST-003', 'missing services are named instead of failing silently', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions', 'tools'] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  const warning = lines.find((line) => line.startsWith('warn'))
  assert.ok(warning !== undefined, 'expected a warning')
  assert.match(warning, /lacks agents, llm, sessionController, sessionQuery, workspaceRegistry/)
  assert.match(warning, /0\.2\.1-rc\.3/)
})

check('TC-HOST-004', 'the expected runtime is named so a version mismatch is actionable', () => {
  const { ctx, lines } = makeCtx({ services: [] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.startsWith('warn') && line.includes('dsh-desktop-next 2.0.20-next')))
})

check('TC-HOST-005', 'a preflight failure never stops the plugin', () => {
  const { ctx } = makeCtx()
  // A context whose service store throws must still let apply wire its listener.
  const broken = {
    ...ctx,
    get: () => {
      throw new Error('service store unavailable')
    },
  }
  assert.doesNotThrow(() => apply(broken, { shadowDir: 'D:\\work\\shadow' }))
})

check('TC-HOST-006', 'a session outside the directory is left alone', () => {
  const { ctx, applied } = makeCtx({ sessions: [{ id: 's-1', header: { cwd: 'D:\\elsewhere' } }] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.deepEqual(applied, [])
})

check('TC-HOST-007', 'the shadow identity is fixed to full access without interactive review', () => {
  const { ctx, lines, applied } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow', permissionPreset: 'auto' })
  assert.ok(lines.includes('info shadow: permission identity danger-full-access; interactive approvals are disabled'), lines.join('\n'))
  assert.deepEqual(applied, ['shadow-1:danger-full-access'])
})

check('TC-HOST-008', 'the listener is registered before the identity diagnostic runs', () => {
  const { ctx, order } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  const listener = order.indexOf('on:session/created')
  const diagnostic = order.findIndex((entry) => entry.startsWith('info:shadow: permission identity'))
  assert.ok(listener !== -1 && diagnostic !== -1, order.join(' -> '))
  assert.ok(listener < diagnostic, `the listener must come first: ${order.join(' -> ')}`)
})

check('TC-HOST-009', 'a recorded user preset is replaced by full access on every shadow mount', () => {
  const { ctx, applied } = makeCtx({ recordedPreset: true })
  apply(ctx, { shadowDir: 'D:\\work\\shadow', permissionPreset: 'auto' })
  assert.deepEqual(applied, ['shadow-1:danger-full-access'])
})

check('TC-HOST-010', 'the full-access identity is pinned when no review preset is offered', () => {
  const { ctx, applied } = makeCtx({ presetNames: ['danger-full-access'] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.deepEqual(applied, ['shadow-1:danger-full-access'])
})

// The resume queue moved to dsh-plugin-restart in 0.10.0, so a runtime without
// the session entry costs this plugin nothing: the permission identity and the
// tools still mount, and nothing here mentions a service it does not need.
check('TC-HOST-011', 'a runtime without the session entry still mounts, and says nothing about it', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions'] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.ok(!lines.some((line) => line.includes('resume queue')), lines.join('\n'))
  assert.ok(lines.some((entry) => entry.includes('permission identity danger-full-access')), lines.join('\n'))
})

// The one thing this half does need beyond the identity services is the session
// listing; a runtime missing only that must still mount.
check('TC-HOST-012', 'a runtime with the identity services mounts without complaint about the queue', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions'] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.ok(!lines.some((line) => line.includes('resume queue')), lines.join('\n'))
})

todo('TC-HOST-013', 'a configured shadowDir that does not exist is named in one warning (TASK-01)')
todo('TC-HOST-014', 'an existing shadowDir produces no directory warning (TASK-01)')

/**
 * A live subagent Session in the shadow directory with an appendable log.
 * @param events - events already in its log.
 * @returns the Session plus the events it was asked to append.
 */
function subagentSession(events = []) {
  const appended = []
  return {
    appended,
    session: {
      id: 'child-1',
      header: { cwd: 'D:\\work\\shadow', parentSession: 'shadow-1' },
      snapshotEvents: () => [...events, ...appended],
      append: (type, data) => { appended.push({ type, data }) },
    },
  }
}

check('TC-HOST-015', 'a subagent in the shadow directory is limited to workspace-write, not given full access', () => {
  const child = subagentSession([{ type: 'permission/preset', data: { preset: 'danger-full-access' } }])
  const { ctx, applied, lines } = makeCtx({ sessions: [child.session], currentPreset: 'danger-full-access' })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(applied, [], 'no preset switch for a subagent')
  assert.deepEqual(child.appended, [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }])
  assert.ok(lines.includes('info shadow: subagent child-1 sandbox -> workspace-write'), lines.join('\n'))
})

check('TC-HOST-016', 'an already-limited subagent is left alone on the next mount', () => {
  const child = subagentSession([{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }])
  const { ctx, applied } = makeCtx({ sessions: [child.session] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(applied, [])
  assert.deepEqual(child.appended, [])
})

check('TC-HOST-017', 'a subagent outside the shadow directory is not touched', () => {
  const child = subagentSession()
  child.session.header.cwd = 'D:\\work\\project'
  const { ctx } = makeCtx({ sessions: [child.session] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(child.appended, [])
})

check('TC-HOST-018', 'the subagent rule is announced in its own startup line', () => {
  const { ctx, lines } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.includes('info shadow: subagents of the shadow run in workspace-write with approvals rejected'), lines.join('\n'))
})

await done()
