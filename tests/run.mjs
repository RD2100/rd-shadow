/**
 * Run the plugin's offline verification. Order: architecture and pure core
 * first (fast, most specific failures), host simulations next, packaging last.
 *
 * Usage: node tests/run.mjs [--deployed]
 *   --deployed  also run the scenarios against the copy installed in the profile
 *
 * Every suite uses tests/harness.mjs; tc-index keeps docs/test-cases.md in step.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TESTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(TESTS)
const DEPLOYED = process.env.SHADOW_PROFILE_TOOLS
const STUB = ['--import', pathToFileURL(path.join(TESTS, 'register.mjs')).href]

/** One runnable check. */
const suites = [
  { label: 'arch', args: [path.join(TESTS, 'arch.test.mjs')] },
  { label: 'dispatch-core', args: [path.join(TESTS, 'dispatch-core.test.mjs')] },
  { label: 'ops', args: [path.join(TESTS, 'ops.test.mjs')] },
  { label: 'runtime-contract', args: [path.join(TESTS, 'runtime-contract.test.mjs')] },
  { label: 'shadow-dir', args: [path.join(TESTS, 'shadow-dir.test.mjs')] },
  { label: 'host-preflight', args: [path.join(TESTS, 'host-preflight.test.mjs')] },
  { label: 'client', args: [path.join(TESTS, 'client.test.mjs')] },
  // The fingerprint turns "did the restart load this code?" into a log line, so
  // its contract (the number follows the bytes) is pinned here rather than trusted.
  { label: 'build-stamp', args: [path.join(TESTS, 'build-stamp.test.mjs')] },
  { label: 'tools-sim', args: [...STUB, path.join(TESTS, 'tools-sim.mjs')] },
  { label: 'patch', args: [path.join(TESTS, 'patch.check.mjs')] },
  { label: 'tc-index', args: [path.join(TESTS, 'tc-index.mjs')] },
  { label: 'pack', args: [path.join(ROOT, 'scripts', 'pack-check.mjs')] },
]

let failures = 0
for (const suite of suites) {
  const result = spawnSync(process.execPath, suite.args, { stdio: 'inherit', cwd: ROOT })
  if (result.status !== 0) {
    failures += 1
    console.error(`${suite.label}: FAILED (exit ${String(result.status)})`)
  }
}

if (process.argv.includes('--deployed')) {
  if (DEPLOYED === undefined || !existsSync(DEPLOYED)) {
    console.log('deployed copy: skipped (set SHADOW_PROFILE_TOOLS to the installed lib/tools.js)')
  } else {
    const deployedRuns = [
      {
        label: 'deployed imports',
        script: 'deployed-imports.mjs',
        env: { SHADOW_LIB: path.dirname(DEPLOYED) },
      },
      {
        label: 'deployed sim',
        script: 'tools-sim.mjs',
        env: { SHADOW_TOOLS: pathToFileURL(DEPLOYED).href },
      },
    ]
    for (const run of deployedRuns) {
      const result = spawnSync(process.execPath, [
        '--import', pathToFileURL(path.join(TESTS, 'register.mjs')).href,
        path.join(TESTS, run.script),
      ], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...run.env } })
      if (result.status !== 0) {
        failures += 1
        console.error(`${run.label}: FAILED`)
      }
    }
  }
}

console.log(failures === 0 ? '\nall suites passed' : `\n${failures} suite(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
