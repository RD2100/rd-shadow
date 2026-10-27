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
 * @param options - which services exist and whether sessions are listed.
 * @returns the fake context plus the collected log lines.
 */
function makeCtx(options = {}) {
  const services = options.services ?? ['permissionPresets', 'sessions']
  const lines = []
  const sessions = options.sessions ?? []
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
          set: () => {},
        },
        sessions: { list: () => sessions },
      }
      for (const name of required) if (scope[name] === undefined) throw new Error(`missing ${name}`)
      callback(scope)
    },
  }
  return { ctx, lines }
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
  const { ctx } = makeCtx({ sessions: [{ id: 's-1', header: { cwd: 'D:\\elsewhere' } }] })
  assert.doesNotThrow(() => apply(ctx, { shadowDir: 'D:\\work\\shadow' }))
})

console.log(`host preflight check: ${passed} checks passed`)
