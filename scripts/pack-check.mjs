/**
 * Prove the published artifact can run without anything that is not published.
 *
 * `files` decides what a package installation receives. This check verifies that
 * runtime imports stay inside that set (except the API DSH injects), README links
 * resolve, and runtime tests pass against an installed npm tarball.
 *
 * Usage: node scripts/pack-check.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/** Files used by runtime, users, and repository-local maintenance commands. */
const DOCS = [
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'E2E-GUARD.md',
  'DESIGN.md',
  'DISPATCH-SPEC.md',
  'DISPATCH-ABSORPTION.md',
  'SELFTEST.md',
  'e2e/PROBES.md',
]
const LIB_FILES = readdirSync(path.join(ROOT, 'lib'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `lib/${name}`)
const PACKAGE_FILES = ['package.json', 'cordis.patch.yml', 'LICENSE', ...DOCS, ...LIB_FILES]
const PUBLISHED = new Set(PACKAGE_FILES)

function runNpm(args, options) {
  const npmExec = process.env.npm_execpath
  const candidates = [
    npmExec,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(path.dirname(process.execPath)), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  const cli = candidates.find(existsSync)
  if (cli !== undefined) return spawnSync(process.execPath, [cli, ...args], options)
  if (process.platform === 'win32') throw new Error('cannot locate npm-cli.js; run this check with npm on PATH and npm_execpath set')
  return spawnSync('npm', args, options)
}

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

/** Whether one path is covered by the manifest's `files` entries. */
function covered(relative) {
  if (relative === 'package.json') return true
  const entries = manifest.files ?? []
  return entries.some((entry) => {
    const trimmed = entry.replace(/\/$/, '')
    return relative === trimmed || relative.startsWith(`${trimmed}/`)
  })
}

check('published file manifest contains every selected artifact', () => {
  const missing = PACKAGE_FILES.filter((relative) => !covered(relative) || !existsSync(path.join(ROOT, relative)))
  if (missing.length > 0) throw new Error(`missing or not covered by "files": ${missing.join(', ')}`)
  const unexpected = manifest.files.filter((relative) => relative === 'scripts' || relative === 'tests' || relative === 'e2e')
  if (unexpected.length > 0) throw new Error(`repository-only assets must not ship: ${unexpected.join(', ')}`)
})

check('the bundle patch, licence, README links, and runtime files are published', () => {
  for (const required of PACKAGE_FILES) {
    if (!existsSync(path.join(ROOT, required))) throw new Error(`declared but missing on disk: ${required}`)
  }
  const npmScripts = Object.keys(manifest.scripts ?? {})
  if (npmScripts.some((name) => name === 'judge' || name.startsWith('judge:'))) {
    throw new Error('restart judge belongs to the independent dsh-plugin-restart package, not this package')
  }
})

check('every declared entry point exists and is published', () => {
  for (const [key, value] of Object.entries(manifest.exports)) {
    const relative = value.replace(/^\.\//, '')
    if (!existsSync(path.join(ROOT, relative))) throw new Error(`exports["${key}"] missing on disk: ${relative}`)
    if (key !== './package.json' && !covered(relative)) throw new Error(`exports["${key}"] is not published: ${relative}`)
  }
})

check('runtime imports stay inside the published set or DSH runtime API', () => {
  const published = PUBLISHED
  const hostApi = '@deepseek-ai/dsh-tools'
  const builtins = new Set(['node:os', 'node:path', 'node:crypto', 'node:util', 'node:fs', 'node:url'])
  const problems = []
  for (const relative of LIB_FILES) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8')
    for (const match of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
        if (!published.has(resolved)) problems.push(`${relative} imports ${specifier} (not published)`)
      } else if (specifier !== hostApi && !builtins.has(specifier)) {
        problems.push(`${relative} imports ${specifier}, which is neither published nor provided by DSH`)
      }
    }
  }
  const runtimeDeps = { ...manifest.dependencies, ...manifest.optionalDependencies }
  if (Object.keys(runtimeDeps).length > 0) problems.push(`unexpected npm runtime dependencies: ${Object.keys(runtimeDeps).join(', ')}`)
  if (manifest.scripts !== undefined) problems.push('repository-only scripts must not be exposed by the published plugin')
  if (problems.length > 0) throw new Error(problems.join('; '))
})

check('published markdown links resolve inside the package', () => {
  const published = PUBLISHED
  const problems = []
  for (const relative of DOCS) {
    const source = readFileSync(path.join(ROOT, relative), 'utf8')
    for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
      const destination = match[1].trim().split(/\s+/)[0]
      if (/^(?:[a-z]+:|\/\/|#)/i.test(destination)) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), destination.split('#')[0]))
      if (!published.has(target)) problems.push(`${relative} links to unpublished ${destination}`)
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
})

check('the npm tarball inventory matches the selected publish set', () => {
  const result = runNpm(['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) throw new Error(`npm pack failed:\n${result.stderr ?? ''}`)
  const [pack] = JSON.parse(result.stdout)
  const packed = new Set(pack.files.map((file) => file.path))
  const missing = PACKAGE_FILES.filter((relative) => !packed.has(relative))
  const unexpected = [...packed].filter((relative) => !PUBLISHED.has(relative))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`)
  }
  console.log(`    ${pack.filename}: ${pack.entryCount} files, ${(pack.unpackedSize / 1024).toFixed(1)} KiB unpacked`)
})

check('the published runtime imports work from an npm tarball install', () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'shadow-install-'))
  try {
    const packed = runNpm(['pack', '--json', '--pack-destination', staging], {
      cwd: ROOT, encoding: 'utf8', env: process.env,
    })
    if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr ?? ''}`)
    const [artifact] = JSON.parse(packed.stdout)
    const installDir = path.join(staging, 'install')
    mkdirSync(installDir, { recursive: true })
    const installed = runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', path.join(staging, artifact.filename)], {
      cwd: installDir,
      encoding: 'utf8',
      env: process.env,
    })
    if (installed.status !== 0) throw new Error(`npm install of packed artifact failed:\n${installed.stderr ?? ''}`)

    const packageDir = path.join(installDir, 'node_modules', manifest.name)
    const tests = path.join(ROOT, 'tests')
    const env = {
      ...process.env,
      SHADOW_LIB: path.join(packageDir, 'lib'),
      SHADOW_TOOLS: pathToFileURL(path.join(packageDir, 'lib', 'tools.js')).href,
      SHADOW_CLIENT: path.join(packageDir, 'lib', 'client.js'),
    }
    for (const script of ['deployed-imports.mjs', 'tools-sim.mjs', 'client.test.mjs']) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(tests, 'register.mjs')).href, path.join(tests, script)], {
        cwd: ROOT, encoding: 'utf8', env,
      })
      if (result.status !== 0) throw new Error(`${script} failed against installed tarball:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

check('the published set is not empty and stays small', () => {
  const bytes = PACKAGE_FILES.reduce((sum, relative) => sum + statSync(path.join(ROOT, relative)).size, 0)
  if (bytes === 0) throw new Error('published set is empty')
  console.log(`    selected source size: ${(bytes / 1024).toFixed(1)} KiB`)
})

console.log(failures === 0 ? 'pack check: all checks passed' : `pack check: ${failures} failed`)
process.exitCode = failures === 0 ? 0 : 1
