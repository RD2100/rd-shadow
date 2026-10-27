/**
 * Copy this package into an installed profile and prove the copy is coherent.
 *
 * Copying a subset of files breaks the plugin in a way that looks like a code
 * bug: one entry imports an export a sibling no longer has, and the runtime
 * reports only "entry did not activate". This script enumerates the runtime file
 * set from disk instead of naming files by hand, then runs the deployed checks
 * so a half-finished copy fails here rather than in a running host.
 *
 * Usage:
 *   node scripts/sync.mjs --to <profile>/node_modules/dsh-plugin-shadow
 *   node scripts/sync.mjs --profile <profile directory>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** Installed package name; the checkout directory may be named differently. */
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name

/** Everything the runtime loads, resolved from disk rather than listed by hand. */
function runtimeFiles() {
  const fixed = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
  const lib = readdirSync(path.join(ROOT, 'lib'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join('lib', name))
  return [...fixed, ...lib]
}

/** Read one flag value. */
function flag(name) {
  const at = process.argv.indexOf(name)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const explicit = flag('--to')
const profile = flag('--profile')
const target = explicit ?? (profile === undefined ? undefined : path.join(profile, 'node_modules', PACKAGE))

if (target === undefined) {
  console.error('usage: node scripts/sync.mjs --to <installed package dir> | --profile <profile dir>')
  process.exit(2)
}
if (!existsSync(path.join(target, 'package.json'))) {
  console.error(`sync: ${target} is not an installed copy of ${PACKAGE} (no package.json)`)
  process.exit(2)
}

const files = runtimeFiles()
for (const relative of files) {
  const from = path.join(ROOT, relative)
  const to = path.join(target, relative)
  if (!existsSync(from)) {
    console.error(`sync: source is missing ${relative}`)
    process.exit(1)
  }
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to)
}
console.log(`sync: copied ${String(files.length)} files into ${target}`)

// Files the installed copy carries that this package no longer ships would stay
// behind and shadow the new code; name them instead of deleting silently.
for (const stale of readdirSync(path.join(target, 'lib')).filter((name) => name.endsWith('.js'))) {
  if (!existsSync(path.join(ROOT, 'lib', stale))) console.warn(`sync: warning: installed copy has extra lib/${stale}`)
}

const verification = spawnSync(process.execPath, [
  path.join(ROOT, 'tests', 'run.mjs'),
  '--deployed',
], {
  stdio: 'inherit',
  cwd: ROOT,
  env: { ...process.env, SHADOW_PROFILE_TOOLS: path.join(target, 'lib', 'tools.js') },
})
if (verification.status !== 0) {
  console.error('sync: deployed verification FAILED — fix before restarting')
  process.exit(1)
}

const bytes = files.reduce((sum, relative) => sum + statSync(path.join(ROOT, relative)).size, 0)
console.log(`sync: ${(bytes / 1024).toFixed(1)} KiB verified`)
console.log('sync: restart DSH to load this copy (HMR does not watch lib/*.js)')
console.log('sync: after restarting, the log must show "shadow: directory <path>" and no "did not activate"')
