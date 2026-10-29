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

import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SHADOW_DIR, directoryKey, expandShadowDir } from './shadow-dir.js'
import { buildStamp } from './build-stamp.js'
import {
  buildResumeMessage,
  classifyResumeError,
  dropResumeEntry,
  readResumeQueue,
  resumeErrorMessage,
  resumeQueuePath,
} from './resume-queue.js'

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
 * 续接队列的重试节奏。
 *
 * 第一次等 30 秒：插件挂载在进程启动后约 3-4 秒（0.8.0 那一轮 relaunch 到宿主自报
 * 构建戳只隔 4 秒），而 provider 的初始化要更久（实测 19 秒处还在报 provider 错）。
 * 投递本身会踢出一个新回合，那一回合要用模型——踢得太早，回合起来就死在 provider
 * 上，消息被消费掉而续接失败。之后每 15 秒一轮，最多 8 轮：约两分钟后还投不出去，
 * 就让记录留在队列里等下一次启动，不无限重试。
 */
const RESUME_FIRST_MS = 30_000
const RESUME_RETRY_MS = 15_000
const RESUME_ATTEMPT_LIMIT = 8

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

  // Which code this host loaded, as one greppable line. Every earlier round
  // verified a deployment by running a probe in a shadow session and decoding
  // its log, which made an operator the bottleneck; a hash of the loaded bytes
  // answers the same question with a restart and a grep, and `npm run
  // fingerprint` prints the number the checkout should produce. Unreadable
  // files cost the line, never the mount — the probe path remains as fallback.
  const stamp = buildStamp()
  const stampLine = stamp === null
    ? 'shadow: build unknown (the runtime files could not be read); verify with a probe instead'
    : `shadow: build ${stamp.hash} over ${String(stamp.files)} files; \`npm run fingerprint\` prints the same number for the checkout, and a mismatch means this host is running an older copy`

  ctx.inject(['permissionPresets', 'sessions'], (scope) => {
    // Name the effective directory once: an installation that points at a
    // directory nobody uses produces no other symptom, so this is the one line
    // that makes a misconfiguration visible.
    scope.logger?.info?.(`shadow: directory ${configuredDir}`)
    scope.logger?.info?.(stampLine)

    /**
     * The preset this deployment can actually apply, if any.
     *
     * Resolved fresh on every call rather than cached, because whether the `auto`
     * identity exists depends on the reviewer plugin being mounted — and that can
     * happen after this fiber mounts. A missing reviewer silently means "full
     * access, never ask", so the mount-time read is logged to make it visible
     * without waiting for a shadow Session to appear.
     * @returns the preset name, or undefined when neither candidate exists.
     */
    const resolveTargetPreset = () => {
      const names = scope.permissionPresets.names
      if (names.includes(preferred)) return preferred
      return names.includes(FALLBACK_PERMISSION_PRESET) ? FALLBACK_PERMISSION_PRESET : undefined
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

    // Functional wiring first: the listener is registered before anything that
    // only reports, so a broken diagnostic can never cost us the pinning.
    scope.on('session/created', pin)

    // Read the catalog once to make the outcome visible; pinning does not depend
    // on this read, and each pin resolves the catalog again. `auto` is
    // contributed by another plugin, so at this instant it may legitimately not
    // exist yet — the wording says "at mount" rather than claiming the reviewer
    // is missing.
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
        `shadow: permission identity unavailable at mount (neither "${preferred}" nor "${FALLBACK_PERMISSION_PRESET}" is offered yet); each pin resolves it again`,
      )
    } else if (identity !== preferred) {
      scope.logger?.info?.(
        `shadow: permission identity ${identity} at mount ("${preferred}" not offered yet); each pin resolves it again, and a missing reviewer would show up as "permission -> ${identity}" there`,
      )
    } else {
      scope.logger?.info?.(`shadow: permission identity ${identity}`)
    }

    // Sessions created before this fiber mounted keep the identity too.
    for (const session of scope.sessions.list()) pin(session)
  })

  // The resume queue: what the judge wrote before it killed this host. Sessions
  // survive a restart with their full history, but the turn that was mid-flight
  // does not come back by itself — without this, every host-half change costs a
  // human poke. Delivery goes through the host's own session entry (the same
  // `resolveAgent` + `send(..., 'next-turn', true)` the shadow's dispatch uses),
  // so no HTTP, no token, and nothing outside the host's process tree.
  try {
    ctx.inject(['sessionController'], (scope) => {
      drainResumeQueue(ctx, scope)
    })
  } catch (error) {
    // A runtime without the session entry cannot deliver anything. Say so once:
    // the queue would otherwise fill up and nobody would know why nothing
    // continued by itself. Everything else in this plugin still mounts.
    ctx.logger?.warn?.(
      `shadow: the resume queue cannot run without the sessionController service (${resumeErrorMessage(error)}); conversations will not continue by themselves after a restart`,
    )
  }
}

/**
 * Deliver what the judge queued before the last restart, and kick those
 * conversations so they continue on their own.
 *
 * Every entry is independent and every failure is either terminal (the session
 * is gone, or the identity belongs to subagent routing) or retryable (the host
 * is still coming up). The first attempt waits for the host's service surface —
 * and its provider — to settle, and the retries are bounded — an entry that never
 * delivers stays in the queue for the next boot rather than spinning forever.
 * @param {{logger?: object, effect?: Function}} ctx - host context; only used for
 *   the disposal hook, so a fiber unload stops the retry chain.
 * @param {{logger?: object, sessionController?: {resolveAgent: Function}}} scope -
 *   injected scope carrying the session entry.
 * @returns {void} the first attempt is scheduled, never awaited.
 */
function drainResumeQueue(ctx, scope) {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.DSH')
  const file = resumeQueuePath(home)
  let stopped = false
  // The disposer is returned, not run: whichever convention this runtime's
  // `ctx.effect` follows, `stopped` must only ever become true when the fiber
  // goes away — never at mount, or the first delivery would be swallowed.
  ctx.effect?.(() => () => { stopped = true })

  /**
   * One pass over the queue.
   * @param {number} round - which attempt this is, 1-based; bounds the retries.
   * @returns {Promise<void>} resolved when the pass finished.
   */
  const attempt = async (round) => {
    if (stopped) return
    let entries
    try {
      entries = readResumeQueue(file)
    } catch (error) {
      scope.logger?.warn?.(`shadow: resume queue unreadable (${resumeErrorMessage(error)}); retrying`)
      entries = []
    }
    if (entries.length === 0) return
    scope.logger?.info?.(
      `shadow: resume queue holds ${String(entries.length)} message(s); delivering so those conversations continue by themselves`,
    )
    /** Whether anything is still pending and worth another round. */
    let retry = false
    for (const entry of entries) {
      if (stopped) return
      try {
        const resolved = await scope.sessionController.resolveAgent(entry.sessionId)
        const agent = resolved?.agent
        if (agent === undefined) {
          // A named session that no longer exists, or one owned by subagent
          // routing, will never accept a generic delivery — drop it and say so.
          // Everything else (writer still held during boot, gateway hiccup)
          // gets another round.
          if (classifyResumeError(resolved?.error) === 'drop') {
            dropResumeEntry(file, entry)
            scope.logger?.warn?.(
              `shadow: resume queue dropped for ${entry.sessionId}: ${resumeErrorMessage(resolved.error)}`,
            )
            continue
          }
          retry = true
          continue
        }
        // Wakeup is the whole point: the resumed Agent is idle, and only the
        // third argument starts the turn that continues the conversation.
        agent.send(buildResumeMessage(entry), 'next-turn', true)
        dropResumeEntry(file, entry)
        scope.logger?.info?.(
          `shadow: resume queue delivered to ${entry.sessionId}; that conversation continues by itself`,
        )
      } catch (error) {
        // The host is still coming up; nothing about the entry is wrong.
        retry = true
      }
    }
    if (!stopped && retry && round < RESUME_ATTEMPT_LIMIT) {
      setTimeout(() => { void attempt(round + 1) }, RESUME_RETRY_MS).unref?.()
    } else if (!stopped && retry) {
      scope.logger?.warn?.(
        `shadow: resume queue gave up after ${String(RESUME_ATTEMPT_LIMIT)} attempts; the entries stay queued for the next boot`,
      )
    }
  }

  setTimeout(() => { void attempt(1) }, RESUME_FIRST_MS).unref?.()
}
