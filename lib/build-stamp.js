/**
 * Fingerprint of the runtime code this host actually loaded.
 *
 * "Did the restart pick up the new guard?" used to be answered by running a
 * probe in a shadow session and decoding its log — a loop that needs an
 * operator at the keyboard. This module turns it into a log line: the host
 * prints a hash of the bytes it loaded, `npm run fingerprint` prints the same
 * number for the checkout, and a restart is verified by comparing two strings.
 *
 * The hash covers the directory this file lives in rather than a version
 * someone declared. A deployed copy edited after its commit, or synced from a
 * dirty tree, still reports its own bytes — which is the number that matters,
 * because the number that matters is what the process is running.
 *
 * Nothing here is a security control and nothing depends on it: a failure to
 * read the files costs one diagnostic line, never the mount. The stamp reads
 * `unknown` in that case, and the probe-and-decode path still works.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * Hash every runtime module next to this one, in a stable order.
 *
 * Each file contributes its name and its bytes, so adding a file changes the
 * fingerprint even when the others are untouched, and renaming one changes it
 * too. Sorted names keep the number reproducible across machines.
 * @returns the short hash and the file count, or null when they cannot be read.
 */
export function buildStamp() {
  try {
    const dir = new URL('.', import.meta.url)
    const names = readdirSync(dir).filter((name) => name.endsWith('.js')).sort()
    if (names.length === 0) return null
    const hash = createHash('sha256')
    for (const name of names) {
      hash.update(name)
      hash.update('\0')
      hash.update(readFileSync(new URL(name, dir)))
      hash.update('\0')
    }
    return { hash: hash.digest('hex').slice(0, 12), files: names.length }
  } catch {
    return null
  }
}
