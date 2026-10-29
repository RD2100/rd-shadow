/**
 * Prove the published artifact can run without anything that is not published.
 *
 * `files` decides what a package installation receives, and this package's tests
 * and docs are deliberately excluded. Nothing checks that the runtime entry
 * points stay inside that set: a stray `import '../tests/...'` or a sibling that
 * only exists in the repository would ship broken and fail on a user's machine.
 *
 * Usage: node scripts/pack-check.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/**
 * The documents an installation receives. The README links to E2E-GUARD.md and
 * the design record, so a tarball without them would ship a README pointing at
 * files nobody has.
 */
const DOCS = [
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'E2E-GUARD.md',
  'DESIGN.md',
  'DISPATCH-SPEC.md',
  'DISPATCH-ABSORPTION.md',
  'SELFTEST.md',
]

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

/** Every runtime file, resolved from disk. */
function libFiles() {
  return readdirSync(path.join(ROOT, 'lib')).filter((name) => name.endsWith('.js')).map((name) => `lib/${name}`)
}

/** Whether one path is covered by the manifest's `files` entries. */
function covered(relative) {
  const entries = manifest.files ?? []
  return entries.some((entry) => {
    const trimmed = entry.replace(/\/$/, '')
    return relative === trimmed || relative.startsWith(`${trimmed}/`)
  })
}

check('every lib/*.js is published', () => {
  const missing = libFiles().filter((relative) => !covered(relative))
  if (missing.length > 0) throw new Error(`not covered by "files": ${missing.join(', ')}`)
})

check('the bundle patch, licence, readme, and the linked docs are published', () => {
  for (const required of ['cordis.patch.yml', 'LICENSE', ...DOCS]) {
    if (!covered(required)) throw new Error(`not covered by "files": ${required}`)
    if (!existsSync(path.join(ROOT, required))) throw new Error(`declared but missing on disk: ${required}`)
  }
})

check('every declared entry point exists and is published', () => {
  for (const [key, value] of Object.entries(manifest.exports)) {
    const relative = value.replace(/^\.\//, '')
    if (!existsSync(path.join(ROOT, relative))) throw new Error(`exports["${key}"] missing on disk: ${relative}`)
    if (key !== './package.json' && !covered(relative)) throw new Error(`exports["${key}"] is not published: ${relative}`)
  }
})

check('runtime imports stay inside the published set', () => {
  const published = new Set(['package.json', 'cordis.patch.yml', ...DOCS, ...libFiles()])
  // node:fs is here deliberately: the script resolver reads package.json and
  // Makefile so `npm run release` can be judged by what it runs. It is a
  // builtin, so the published set still stands alone.
  // node:url is here for the same reason: the live core re-imports a module by
  // URL, and on Windows an absolute path is not a valid URL — pathToFileURL is
  // the only correct way to build one. Builtin, so the set still stands alone.
  const allowedBare = new Set(['@deepseek-ai/dsh-tools', 'node:os', 'node:path', 'node:crypto', 'node:util', 'node:fs', 'node:url'])
  // The dev scripts are published so an installation can run the same judge; their
  // imports must therefore stay inside the builtins plus the package's own files.
  // The full builtin list is allowed here, unlike the runtime one above, because a
  // script that shells out is doing its job — nothing in lib/ may.
  const allowedScripts = new Set([...allowedBare, 'node:child_process', 'node:process', 'node:url', 'node:assert'])
  const scriptFiles = ['scripts/verify-and-restart.mjs', 'scripts/restart-host.mjs', 'scripts/fingerprint.mjs', 'scripts/sync.mjs']
  const scriptProblems = []
  for (const relative of scriptFiles) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8')
    for (const match of source.matchAll(/^\s*import\s[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (specifier.startsWith('node:')) {
        if (!allowedScripts.has(specifier)) scriptProblems.push(`${relative} imports ${specifier}`)
      } else if (!specifier.startsWith('.')) {
        scriptProblems.push(`${relative} imports runtime-provided ${specifier}`)
      } else {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
        if (!published.has(resolved) && !scriptFiles.includes(resolved)) {
          scriptProblems.push(`${relative} imports ${specifier} (not published)`)
        }
      }
    }
  }
  if (scriptProblems.length > 0) throw new Error(scriptProblems.join('; '))
  const problems = []
  for (const relative of libFiles()) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8')
    for (const match of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
        if (!published.has(resolved)) problems.push(`${relative} imports ${specifier} (not published)`)
      } else if (!allowedBare.has(specifier)) {
        problems.push(`${relative} imports runtime-provided ${specifier} (allowlist it deliberately)`)
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
})

check('a copy of only the published files still runs the tools suite', () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'shadow-pack-'))
  try {
    for (const relative of ['package.json', 'cordis.patch.yml', 'LICENSE', ...DOCS, ...libFiles()]) {
      const to = path.join(staging, relative)
      cpSync(path.join(ROOT, relative), to, { recursive: true })
    }
    const tests = path.join(ROOT, 'tests')
    const verification = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(tests, 'register.mjs')).href,
      path.join(tests, 'tools-sim.mjs'),
    ], {
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, SHADOW_TOOLS: pathToFileURL(path.join(staging, 'lib', 'tools.js')).href },
    })
    if (verification.status !== 0) {
      throw new Error(`packed copy failed the tools suite:\n${verification.stdout ?? ''}${verification.stderr ?? ''}`)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

check('the published set is not empty and stays small', () => {
  const bytes = ['package.json', 'cordis.patch.yml', 'LICENSE', ...DOCS, ...libFiles()]
    .reduce((sum, relative) => sum + statSync(path.join(ROOT, relative)).size, 0)
  if (bytes === 0) throw new Error('published set is empty')
  console.log(`    published size: ${(bytes / 1024).toFixed(1)} KiB`)
})

console.log(failures === 0 ? 'pack check: all checks passed' : `pack check: ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
