/**
 * Host half of the shadow plugin.
 *
 * Layer: entry (host half). Imports: shadow-dir.js, build-stamp.js only.
 *
 * Two responsibilities:
 * 1. The row exists so the modules scanner reads this package's `dsh.client`
 *    declaration and loads the browser half.
 * 2. Every Session that lives in the shadow's dedicated directory receives the
 *    fixed full-access permission, without interactive approval, instead
 *    of inheriting whatever the deployment default happens to be.
 *
 * Identity is the directory, not the agent preset. A Session header records the
 * preset it was created with, and a later `agent-preset/selected` event is what
 * actually takes effect, so the header cannot be trusted here. `cwd` is fixed at
 * creation and needs no projection fold, which makes it the reliable signal.
 *
 * The permission is applied through the official `permissionPresets` service, so
 * the decision is durable in the Session log and visible in the composer's
 * permission picker like any other switch.
 */

/** Loader row name; must equal the package name so resolution finds this entry. */
export const name = 'dsh-plugin-shadow'

import { DEFAULT_SHADOW_DIR, directoryKey, expandShadowDir } from './shadow-dir.js'
import { buildStamp } from './build-stamp.js'

/** Fixed identity: full access, with no interactive approval step. */
const PERMISSION_PRESET = 'danger-full-access'

/** Host services the tools entry needs before it can dispatch anything. */
const TOOLS_SERVICES = [
  'agents',
  'llm',
  'sessionController',
  'sessionQuery',
  'sessions',
  'tools',
  'workspaceRegistry',
]

/** Runtime this build was verified against; named in diagnostics, never enforced. */
const EXPECTED_RUNTIME = 'dsh harness 0.2.1-rc.3 (dsh-desktop-next 2.0.20-next)'

/**
 * Name every precondition this installation is missing, once, at startup.
 *
 * A missing service or an unresolvable runtime package makes the shadow's tools
 * fail later with an error that names nothing useful. Reporting it here turns
 * that into one actionable line while the host is still starting, and it is the
 * only place that can see both halves.
 * @param ctx - host context; reads the service store, never mutates it.
 */
function reportPreflight(ctx) {
  const logger = ctx.logger
  try {
    const missing = TOOLS_SERVICES.filter((name) => ctx.get(name) === undefined)
    if (missing.length > 0) {
      logger?.warn?.(
        `shadow: this runtime lacks ${missing.join(', ')}; the shadow's tools cannot work. Expected ${EXPECTED_RUNTIME}.`,
      )
    }
  } catch (error) {
    logger?.warn?.('shadow: preflight service check failed', error)
  }
}

/**
 * Pin every shadow Session to the fixed full-access identity.
 * @param ctx - host context supplying the permission and Session services.
 * @param config - optional row config naming the shadow directory.
 * @returns nothing; registrations are disposed with the plugin fiber.
 */
export function apply(ctx, config) {
  const configuredDir = expandShadowDir(config?.shadowDir) ?? DEFAULT_SHADOW_DIR
  const shadowDir = directoryKey(configuredDir)
  reportPreflight(ctx)

  // Identify the loaded runtime bytes in one greppable line. The checkout-only
  // `node scripts/fingerprint.mjs` command prints the expected hash.
  const stamp = buildStamp()
  const stampLine = stamp === null
    ? 'shadow: build unknown (the runtime files could not be read); verify with a probe instead'
    : `shadow: build ${stamp.hash} over ${String(stamp.files)} files; \`node scripts/fingerprint.mjs\` prints the same number for the checkout, and a mismatch means this host is running an older copy`

  ctx.inject(['permissionPresets', 'sessions'], (scope) => {
    // Name the effective directory once: an installation that points at a
    // directory nobody uses produces no other symptom, so this is the one line
    // that makes a misconfiguration visible.
    scope.logger?.info?.(`shadow: directory ${configuredDir}`)
    scope.logger?.info?.(stampLine)

    const pin = (session) => {
      // A listener must never turn an unrelated Session creation into a failure.
      try {
        if (directoryKey(session?.header?.cwd) !== shadowDir) return
        if (scope.permissionPresets.current?.(session) === PERMISSION_PRESET) return
        scope.permissionPresets.set(session, PERMISSION_PRESET)
        scope.logger?.info?.(`shadow: ${session.id} permission -> ${PERMISSION_PRESET}`)
      } catch (error) {
        scope.logger?.warn?.('shadow: could not apply the full-access identity', error)
      }
    }

    // Functional wiring first: a newly-created shadow Session is put in the
    // fixed preset before any diagnostic can fail.
    scope.on('session/created', pin)

    scope.logger?.info?.(`shadow: permission identity ${PERMISSION_PRESET}; interactive approvals are disabled`)

    // Sessions created before this fiber mounted keep the same identity too.
    for (const session of scope.sessions.list()) pin(session)
  })

  // Restart and resume ownership moved to the independent `dsh-plugin-restart` package in 0.10.0.
}
