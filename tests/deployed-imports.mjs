/**
 * Load the installed copy's runtime entries through the real module graph.
 *
 * A half-finished sync leaves one file importing an export another file no
 * longer has; `node --check` cannot see that, and the runtime reports it only as
 * a failed plugin activation. Importing the installed entries here turns it into
 * a failing test before it reaches a running host.
 *
 * Usage: SHADOW_LIB=<installed lib directory> node --import ./tests/register.mjs ./tests/deployed-imports.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildStamp } from '../lib/build-stamp.js'

const LIB = process.env.SHADOW_LIB
let failures = 0

/**
 * Import one entry and report what it exposes.
 * @param name - file name inside the installed lib directory.
 * @param expected - exports that must be present.
 */
async function load(name, expected) {
  const file = path.join(LIB, name)
  try {
    const module = await import(pathToFileURL(file).href)
    const missing = expected.filter((key) => module[key] === undefined)
    if (missing.length > 0) throw new Error(`missing exports: ${missing.join(', ')}`)
    console.log(`ok   ${name}: ${expected.join(', ')}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

await load('shadow-dir.js', ['DEFAULT_SHADOW_DIR', 'directoryKey', 'expandShadowDir'])
await load('dispatch-core.js', ['deriveMessageId', 'deliveryEvidence', 'renderTargets'])
await load('index.js', ['name', 'apply'])
await load('tools.js', ['name', 'inject', 'apply'])

// The fingerprint the host will log for the installed copy must equal the one
// the checkout produces. A half-synced copy that still imports cleanly would
// otherwise pass every other check here while the host quietly runs the older
// guard — the failure this comparison exists to catch.
const checkout = buildStamp()
const installed = await import(pathToFileURL(path.join(LIB, 'build-stamp.js')).href).then((m) => m.buildStamp())
if (checkout === null || installed === null) {
  failures += 1
  console.error('FAIL build stamp: unreadable runtime files on one side')
} else if (checkout.hash !== installed.hash || checkout.files !== installed.files) {
  failures += 1
  console.error(`FAIL build stamp: checkout ${checkout.hash} (${String(checkout.files)} files) != installed ${installed.hash} (${String(installed.files)} files)`)
} else {
  console.log(`ok   build stamp: installed copy is ${installed.hash} over ${String(installed.files)} files, same as the checkout`)
}

console.log(failures === 0 ? 'deployed imports: all entries load' : `deployed imports: ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
