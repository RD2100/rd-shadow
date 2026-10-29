/**
 * Checks for the host half's startup preflight.
 *
 * The preflight exists so a mis-installed runtime fails visibly: a shadow whose
 * tools silently do not work is worse than one that refuses to start. These
 * checks drive `apply` with a fake context and assert what it reports.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

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
        // The resume queue's inject asks for this one. A stub whose only answer
        // is "no such session" keeps the drainer's schedule inert in tests; the
        // 10s first attempt never fires because the checks below are synchronous
        // and the timer is unref'd. A runtime that lacks the service must make
        // the inject throw, so the stub is offered only when the runtime has it.
        ...(required.includes('sessionController') && services.includes('sessionController')
          ? { sessionController: { resolveAgent: async () => ({ error: { code: 'session/not-found', message: 'the fake host stores no sessions' } }) } }
          : {}),
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

check('names the effective directory at startup', () => {
  const { ctx, lines } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.includes('shadow: directory D:\\work\\shadow')), lines.join('\n'))
})

check('a fully equipped runtime reports no missing service', () => {
  const { ctx, lines } = makeCtx({
    services: ['permissionPresets', 'sessions', 'agents', 'llm', 'sessionController', 'sessionQuery', 'tools', 'workspaceRegistry'],
  })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(lines.filter((line) => line.startsWith('warn')), [], lines.join('\n'))
})

check('missing services are named instead of failing silently', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions', 'tools'] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  const warning = lines.find((line) => line.startsWith('warn'))
  assert.ok(warning !== undefined, 'expected a warning')
  assert.match(warning, /lacks agents, llm, sessionController, sessionQuery, workspaceRegistry/)
  assert.match(warning, /0\.2\.1-rc\.3/)
})

check('the expected runtime is named so a version mismatch is actionable', () => {
  const { ctx, lines } = makeCtx({ services: [] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.startsWith('warn') && line.includes('dsh-desktop-next 2.0.20-next')))
})

check('a preflight failure never stops the plugin', () => {
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

check('a session outside the directory is left alone', () => {
  const { ctx, applied } = makeCtx({ sessions: [{ id: 's-1', header: { cwd: 'D:\\elsewhere' } }] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.deepEqual(applied, [])
})

check('the available identity is named at mount, so "is the reviewer mounted" is observable', () => {
  const { ctx, lines } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.includes('info shadow: permission identity auto'), lines.join('\n'))
})

check('a missing reviewer is reported as an unreviewed fallback, not silence', () => {
  const { ctx, lines } = makeCtx({ presetNames: ['danger-full-access'] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  const line = lines.find((entry) => entry.includes('permission identity danger-full-access'))
  assert.ok(line !== undefined, lines.join('\n'))
  // The claim is bounded to the mount instant: the reviewer is contributed by
  // another plugin, so "not offered yet" must not read as "never offered".
  assert.match(line, /not offered yet/)
  assert.match(line, /each pin resolves it again/)
})

check('the listener is registered before the identity diagnostic runs', () => {
  const { ctx, order } = makeCtx()
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  const listener = order.indexOf('on:session/created')
  const diagnostic = order.findIndex((entry) => entry.startsWith('info:shadow: permission identity'))
  assert.ok(listener !== -1 && diagnostic !== -1, order.join(' -> '))
  assert.ok(listener < diagnostic, `the listener must come first: ${order.join(' -> ')}`)
})

check('a reviewer that mounts later is still pinned, not written off at mount', () => {
  const { ctx, applied } = makeCtx({
    presetNames: ['danger-full-access'],
    presetNamesAfter: ['auto', 'danger-full-access'],
  })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(applied, ['shadow-1:auto'], 'the pin must read the catalog again')
})

check('a runtime with neither candidate reports the identity it cannot apply', () => {
  const { ctx, lines } = makeCtx({ presetNames: ['workspace-write'] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.includes('permission identity unavailable')), lines.join('\n'))
})

check('an unreadable catalog is reported instead of staying silent', () => {
  const { ctx, lines } = makeCtx({ catalogThrows: 'registry not started' })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  const line = lines.find((entry) => entry.includes('permission identity unknown'))
  assert.ok(line !== undefined, lines.join('\n'))
  assert.match(line, /registry not started/)
})

check('by default the shadow identity is enforced over a recorded preset', () => {
  const { ctx, applied } = makeCtx({ recordedPreset: true })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.deepEqual(applied, ['shadow-1:auto'])
})

check('enforcePermissionPreset:false keeps a preset the user chose', () => {
  const { ctx, applied } = makeCtx({ recordedPreset: true })
  apply(ctx, { shadowDir: 'D:\\work\\shadow', enforcePermissionPreset: false })
  assert.deepEqual(applied, [], 'a recorded preset must not be overridden')
})

check('enforcePermissionPreset:false still pins a session with no recorded preset', () => {
  const { ctx, applied } = makeCtx({ recordedPreset: false })
  apply(ctx, { shadowDir: 'D:\\work\\shadow', enforcePermissionPreset: false })
  assert.deepEqual(applied, ['shadow-1:auto'])
})

check('an unreadable log counts as recorded, so the user keeps their choice', () => {
  const { ctx, applied } = makeCtx({ unreadableLog: true })
  apply(ctx, { shadowDir: 'D:\\work\\shadow', enforcePermissionPreset: false })
  assert.deepEqual(applied, [])
})

// The resume queue needs the session entry. A runtime without it cannot deliver
// anything — that must cost one warning, never the mount: the permission
// identity and the tools still work, and only the automatic continuation dies.
check('a runtime without the session entry still mounts, and says what died', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions'] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  const line = lines.find((entry) => entry.includes('resume queue cannot run'))
  assert.ok(line !== undefined, lines.join('\n'))
  assert.match(line, /sessionController/)
  assert.ok(lines.some((entry) => entry.includes('permission identity auto')), lines.join('\n'))
})

// With the service present the drainer is scheduled, not skipped: the host half
// must not log a complaint it does not have. (The preflight's own "lacks ..."
// warning is expected here — the fake still omits the tools' services.)
check('a runtime with the session entry schedules the queue without complaint', () => {
  const { ctx, lines } = makeCtx({ services: ['permissionPresets', 'sessions', 'sessionController'] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
  assert.ok(!lines.some((line) => line.includes('resume queue cannot run')), lines.join('\n'))
})

console.log(`host preflight check: ${passed} checks passed`)
