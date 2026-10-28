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
  /** Whether a recorded preset may be overridden; opt-out for hands-off deployments. */
  const enforcePreset = config?.enforcePermissionPreset !== false

  reportPreflight(ctx)

  ctx.inject(['permissionPresets', 'sessions'], (scope) => {
    // Name the effective directory once: an installation that points at a
    // directory nobody uses produces no other symptom, so this is the one line
    // that makes a misconfiguration visible.
    scope.logger?.info?.(`shadow: directory ${configuredDir}`)

    /**
     * The preset this deployment can actually apply, if any.
     *
     * Resolved once at mount because the answer is deployment-wide: whether the
     * `auto` identity exists at all depends on the reviewer plugin being mounted,
     * and a missing reviewer silently means "full access, never ask". Logging it
     * here makes that visible without waiting for a shadow Session to appear.
     * @returns the preset name, or undefined when neither candidate exists.
     */
    const resolveTargetPreset = () => {
      const names = scope.permissionPresets.names
      if (names.includes(preferred)) return preferred
      return names.includes(FALLBACK_PERMISSION_PRESET) ? FALLBACK_PERMISSION_PRESET : undefined
    }

    // Resolve the identity once at mount so "is the reviewer mounted" is
    // observable without waiting for a Session to appear. The outcome is always
    // reported through `info`, which is proven to reach this log: a `warn`-only
    // diagnostic was indistinguishable from the code never running at all.
    let identity
    let failure
    try {
      identity = resolveTargetPreset()
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== undefined) {
      scope.logger?.info?.(
        `shadow: permission identity unknown (catalog unreadable at mount: ${failure}); it is resolved again on every pin`,
      )
    } else if (identity === undefined) {
      scope.logger?.info?.(
        `shadow: permission identity unavailable (neither "${preferred}" nor "${FALLBACK_PERMISSION_PRESET}" is offered); shadow Sessions inherit whatever identity they start with`,
      )
    } else if (identity !== preferred) {
      // The preferred identity is unavailable, which in practice means the
      // per-call reviewer is not mounted: say so rather than degrading quietly.
      scope.logger?.info?.(
        `shadow: permission identity ${identity} (fallback: "${preferred}" is unavailable, so no per-call review will happen — is @deepseek-ai/dsh-experimental-auto-review in this profile's bundles?)`,
      )
    } else {
      scope.logger?.info?.(`shadow: permission identity ${identity}`)
    }

    /**
     * Whether this Session's log already records a permission choice.
     *
     * `permissionPresets.current()` derives from folded knobs and always answers,
     * so it cannot tell "the user chose this" from "the deployment default is
     * this". Only the log can. An unreadable log counts as recorded: leaving a
     * user's choice alone is the safer mistake.
     * @param session - the accepted Session.
     * @returns true when the log carries a `permission/preset` event.
     */
    const hasRecordedPreset = (session) => {
      try {
        return session.snapshotEvents().some((event) => event.type === 'permission/preset')
      } catch {
        return true
      }
    }

    const pin = (session) => {
      // A listener must never turn an unrelated Session creation into a failure.
      try {
        if (directoryKey(session?.header?.cwd) !== shadowDir) return
        if (!enforcePreset && hasRecordedPreset(session)) return
        // Already reported at mount; a missing identity has nothing to apply.
        const target = resolveTargetPreset()
        if (target === undefined) return
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
