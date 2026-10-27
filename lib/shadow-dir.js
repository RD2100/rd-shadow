/**
 * The one owner of "which directory is the shadow's own".
 *
 * Three places need the same answer: the host half pins the permission identity
 * of every Session in that directory, the tools half refuses a dispatch whose
 * caller is not one of them, and the client half lists and creates Sessions
 * there. Keeping the rule here keeps the halves from drifting apart.
 *
 * The default is derived from the user's home directory rather than shipping a
 * development machine's path, so an installation on another machine still points
 * at a directory that can be created. A deployment that wants a specific
 * location sets `shadowDir` on the plugin row; `~` expands there too.
 */

import os from 'node:os'
import path from 'node:path'

/** Portable default: a sibling of the user's home directory, not a machine path. */
export const DEFAULT_SHADOW_DIR = path.join(os.homedir(), 'dsh-shadow')

/**
 * Resolve one configured directory spelling into an absolute path.
 *
 * A leading `~` means the user's home directory, because a bundle patch ships
 * the same YAML to every machine and cannot know one user's home path.
 * @param value - the configured value, possibly empty or undefined.
 * @returns the absolute path, or undefined when the value is not a path.
 */
export function expandShadowDir(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return trimmed
}

/**
 * Compare two directory spellings regardless of separators or a trailing slash.
 *
 * A Session header records the cwd it was created with, and a deployment may
 * spell the same directory either way, so comparison normalizes before it
 * decides.
 * @param value - a recorded or configured path.
 * @returns a comparable key, or undefined when the value is not a path.
 */
export function directoryKey(value) {
  return typeof value === 'string' && value.length > 0
    ? value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : undefined
}
