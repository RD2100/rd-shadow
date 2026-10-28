/**
 * Run the plugin's offline verification: the pure-core checks, the host-sim
 * integration scenarios, and the bundle-patch validation.
 *
 * Usage: node tests/run.mjs [--deployed]
 *   --deployed  also run the scenarios against the copy installed in the profile
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TESTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(TESTS)
const DEPLOYED = process.env.SHADOW_PROFILE_TOOLS

/** One runnable check. */
const suites = [
  { label: 'shadow-dir', args: [path.join(TESTS, 'shadow-dir.test.mjs')] },
  { label: 'host-preflight', args: [path.join(TESTS, 'host-preflight.test.mjs')] },
  { label: 'client', args: [path.join(TESTS, 'client.test.mjs')] },
  { label: 'dispatch-core', args: [path.join(TESTS, 'dispatch-core.test.mjs')] },
  // The fuzz generates the spellings the hand-written suites would have to
  // think of, and asserts both halves: a call that reaches the network is never
  // silent, and a command that cannot is never asked about. Deterministic, so a
  // failure in CI reproduces locally from the printed seed.
  { label: 'fuzz', args: [path.join(TESTS, 'fuzz.mjs')] },
  { label: 'tools-sim', args: ['--import', pathToFileURL(path.join(TESTS, 'register.mjs')).href, path.join(TESTS, 'tools-sim.mjs')] },
  { label: 'patch', args: [path.join(TESTS, 'patch.check.mjs')] },
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
