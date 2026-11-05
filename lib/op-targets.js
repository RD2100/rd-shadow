/**
 * `shadow_targets`: list the workspaces and Sessions a dispatch could address.
 *
 * Layer: op. Imports: core-*. Read-only (docs/detailed-design.md §4.5).
 */

import { REASON, TARGETS_PAGE_DEFAULT, TARGETS_PAGE_MAX } from './core-contract.js'
import { renderTargets } from './core-render.js'

/**
 * Clamp a requested per-workspace page size into [1, TARGETS_PAGE_MAX].
 * @param limit - the caller's value, possibly undefined.
 * @returns the effective page size.
 */
export function targetsPageLimit(limit) {
  const requested = typeof limit === 'number' ? limit : TARGETS_PAGE_DEFAULT
  return Math.min(Math.max(1, Math.trunc(requested)), TARGETS_PAGE_MAX)
}

/**
 * Collect titles from `readTitleSnapshots` results.
 *
 * Each entry is `{sessionId, status, value|reason}`; a fulfilled value holds
 * the Session header plus a title snapshot whose `.title` is the string. A
 * rejected entry is skipped without hiding the others.
 * @param snapshots - the settled results.
 * @returns titles by Session id.
 */
export function collectTitles(snapshots) {
  const titles = new Map()
  for (const entry of snapshots) {
    if (entry?.status !== 'fulfilled') continue
    const id = entry.value?.session?.id
    if (typeof id !== 'string') continue
    const title = entry.value.title?.title
    if (typeof title === 'string' && title.length > 0) titles.set(id, title)
  }
  return titles
}

/**
 * Run one catalog listing.
 * @param host - the host adapter from host-io.js.
 * @param args - `{workspaceId?, limit?}`.
 * @param exec - the executing tool call.
 * @returns the model-facing catalog text.
 */
export async function targets(host, args, exec) {
  const { scope } = host

  // T0 bind.
  const bound = host.bind(exec)
  if (bound.code !== undefined) {
    return [`shadow_targets -> ${bound.code}`, `reason: ${bound.detail}`].join('\n')
  }

  // T1 workspace selection.
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

  // T2 paging.
  const limit = targetsPageLimit(args.limit)
  const pages = workspaces.map((workspace) => {
    const ids = workspace.sessionIds
    return { workspace, ids: ids.slice(0, limit), omitted: Math.max(0, ids.length - limit) }
  })
  const wanted = [...new Set(pages.flatMap((page) => page.ids))]

  // T3 headers and titles. A title is a convenience; a failed read must not hide
  // the ids and states the caller actually needs.
  let records = new Map()
  let titles = new Map()
  if (wanted.length > 0) {
    records = new Map((await scope.sessionQuery.listSessions(exec.signal)).map((record) => [record.header.id, record]))
    try {
      titles = collectTitles(await scope.sessionQuery.readTitleSnapshots(wanted, exec.signal))
    } catch {
      // TODO(TASK-02): surface the failure as a `titles:` line instead of dropping it.
      titles = new Map()
    }
  }

  // T4 render. agent.status is only 'idle' | 'running' in rc.3.
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
