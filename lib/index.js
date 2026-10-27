/**
 * Host half of the shadow plugin.
 *
 * Two responsibilities:
 * 1. The row exists so the modules scanner reads this package's `dsh.client`
 *    declaration and loads the browser half.
 * 2. Every Session that lives in the shadow's dedicated directory receives the
 *    shadow's permission identity — full sandbox plus per-call review — instead
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

/** Preferred identity: full sandbox, and only irreversible calls ask the user. */
const DEFAULT_PERMISSION_PRESET = 'auto'

/** Identity used when the per-call reviewer is not mounted in this deployment. */
const FALLBACK_PERMISSION_PRESET = 'danger-full-access'

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
 * Give every shadow Session the configured permission identity.
 * @param ctx - host context supplying the permission and Session services.
 * @param config - optional row config overriding the directory and preset ids.
 * @returns nothing; registrations are disposed with the plugin fiber.
 */
export function apply(ctx, config) {
  const configuredDir = expandShadowDir(config?.shadowDir) ?? DEFAULT_SHADOW_DIR
  const shadowDir = directoryKey(configuredDir)
  const preferred = typeof config?.permissionPreset === 'string' && config.permissionPreset.length > 0
    ? config.permissionPreset
    : DEFAULT_PERMISSION_PRESET

  reportPreflight(ctx)

  ctx.inject(['permissionPresets', 'sessions'], (scope) => {
    // Name the effective directory once: an installation that points at a
    // directory nobody uses produces no other symptom, so this is the one line
    // that makes a misconfiguration visible.
    scope.logger?.info?.(`shadow: directory ${configuredDir}`)

    const pin = (session) => {
      // A listener must never turn an unrelated Session creation into a failure.
      try {
        if (directoryKey(session?.header?.cwd) !== shadowDir) return
        const names = scope.permissionPresets.names
        const target = names.includes(preferred)
          ? preferred
          : names.includes(FALLBACK_PERMISSION_PRESET) ? FALLBACK_PERMISSION_PRESET : undefined
        if (target === undefined) {
          scope.logger?.warn?.(`shadow: no usable permission preset (tried "${preferred}" and "${FALLBACK_PERMISSION_PRESET}")`)
          return
        }
        // Re-selecting the effective preset appends no events, so skip a redundant
        // write and log only a real change. That log is the observable proof this
        // half ran, which an idempotent no-op would otherwise hide.
        if (typeof scope.permissionPresets.current === 'function'
          && scope.permissionPresets.current(session) === target) return
        scope.permissionPresets.set(session, target)
        scope.logger?.info?.(`shadow: ${session.id} permission -> ${target}`)
      } catch (error) {
        scope.logger?.warn?.('shadow: could not apply the permission identity', error)
      }
    }

    scope.on('session/created', pin)
    // Sessions created before this fiber mounted keep the identity too.
    for (const session of scope.sessions.list()) pin(session)
  })
}
