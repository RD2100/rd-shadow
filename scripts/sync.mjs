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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStamp } from '../lib/build-stamp.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
/** Installed package name; the checkout directory may be named differently. */
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name

/**
 * Everything the runtime loads, in the order it must be copied.
 *
 * `cordis.patch.yml` goes last on purpose: DSH's HMR reacts to a profile config
 * change by recomposing, and that recompose re-imports the entry points while
 * possibly reusing cached siblings. Copying the patch first therefore hands the
 * watcher a new entry next to old modules — the exact skew that made the plugin
 * fail to import on 2026-10-28. Copying code first means any recompose it
 * triggers already sees a consistent module set.
 */
function runtimeFiles() {
  const docs = ['README.md', 'LICENSE']
  const manifest = ['package.json']
  const lib = readdirSync(path.join(ROOT, 'lib'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join('lib', name))
  return [...manifest, ...docs, ...lib, 'cordis.patch.yml']
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
  // 同一台机器上 checkout 与部署副本可能共享同一批 inode（`file:`/`link:` 装法是
  // 硬链，不是拷贝）。这时 cpSync 报 ERR_FS_CP_EINVAL——不是错误，是「本来就是同一份」，
  // 跳过即可。realpathSync 看穿路径别名，statSync 看穿硬链，两个都要比。
  if (realpathSync(from) === realpathSync(to)) continue
  const fromStat = statSync(from)
  const toStat = existsSync(to) ? statSync(to) : undefined
  if (toStat !== undefined && fromStat.dev === toStat.dev && fromStat.ino === toStat.ino) continue
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
// What the host must log after the restart. Every earlier round answered "did
// the new code load?" with a probe run and a decoded session log, which put an
// operator in the loop; the fingerprint turns it into one grep. The hash covers
// the files just copied, so it is the number this copy must produce.
const stamp = buildStamp()
console.log(`sync: after restarting, the log must show "shadow: build ${stamp?.hash ?? '<unreadable>'}" and "shadow: directory <path>", and no "did not activate"`)
console.log('sync: HMR does not watch lib/*.js, so the restart is what loads this copy')

