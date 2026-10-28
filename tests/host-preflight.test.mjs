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
  const events = options.recordedPreset === false ? [] : [{ type: 'permission/preset', data: { preset: 'workspace-write' } }]
  const sessions = options.sessions ?? [{
    id: 'shadow-1',
    header: { cwd: 'D:\\work\\shadow' },
    snapshotEvents: () => (options.unreadableLog === true ? throwUnreadable() : events),
  }]
  const ctx = {
    logger: {
      info: (message) => lines.push(`info ${message}`),
      warn: (message) => lines.push(`warn ${message}`),
    },
    get: (name) => (services.includes(name) ? { name } : undefined),
    inject: (required, callback) => {
      const scope = {
        logger: ctx.logger,
        on: () => {},
        permissionPresets: {
          names: options.presetNames ?? ['auto', 'danger-full-access'],
          current: () => options.currentPreset ?? 'workspace-write',
          set: (session, target) => applied.push(`${session.id}:${target}`),
        },
        sessions: { list: () => sessions },
      }
      for (const name of required) if (scope[name] === undefined) throw new Error(`missing ${name}`)
      callback(scope)
    },
  }
  return { ctx, lines, applied }
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
  const warning = lines.find((line) => line.startsWith('warn') && line.includes('no per-call review'))
  assert.ok(warning !== undefined, lines.join('\n'))
  assert.match(warning, /experimental-auto-review/)
})

check('a runtime with neither candidate warns about the identity it cannot apply', () => {
  const { ctx, lines } = makeCtx({ presetNames: ['workspace-write'] })
  apply(ctx, { shadowDir: 'D:\\work\\shadow' })
  assert.ok(lines.some((line) => line.startsWith('warn') && line.includes('no usable permission preset')), lines.join('\n'))
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

console.log(`host preflight check: ${passed} checks passed`)
