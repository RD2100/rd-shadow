#!/usr/bin/env node
/**
 * Print the build fingerprint of this checkout's runtime code.
 *
 * The number is what the host logs at mount as `shadow: build <hash>`, so
 * after a restart the two must match. The command exists because comparing
 * against a copy you did not just sync — one installed by hand, or one a
 * colleague made — is the case where a stale copy is easiest to miss.
 *
 * Usage: npm run fingerprint
 */
import { buildStamp } from '../lib/build-stamp.js'

const stamp = buildStamp()
if (stamp === null) {
  console.error('fingerprint: cannot read lib/*.js in this checkout')
  process.exit(1)
}
console.log(`build ${stamp.hash} over ${String(stamp.files)} files`)
console.log('after a restart, the host log must show the same number as "shadow: build <hash>"')
