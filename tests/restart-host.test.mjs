/**
 * Pin the two properties the automatic round rests on: the worker really runs
 * outside the host's process tree, and every way the round can go wrong lands on
 * the ledger.
 *
 * The first is the load-bearing one. The judge runs inside the host's process
 * tree — the host is one of its ancestors — so the moment it taskkills the app it
 * dies too, before it could relaunch anything. That is why the relaunch and the
 * verification belong to a worker started by WMI or the scheduler, both of which
 * are hosted by a Windows service rather than by the judge. A plain child_process
 * spawn would sit in the doomed tree, so the spawn path is asserted here rather
 * than trusted.
 *
 * The second keeps the round auditable: an app that will not exit, a relaunch
 * that throws, a host that reports the wrong build, a host that never reports at
 * all — each has to produce a line, not a silence.
 *
 * Usage: node tests/restart-host.test.mjs
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const { runWorker, waitForExit } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'restart-host.mjs')).href)
const { readLedger, spawnWorkerOutsideTree, workerCommand } = await import(
  pathToFileURL(path.join(ROOT, 'scripts', 'verify-and-restart.mjs')).href)

const EXPECT = '2d34d559ff9f'
const COMMIT = '40ff26e'
let failures = 0

/** Report one assertion. */
function check(label, ok, detail = '') {
  if (ok) console.log(`ok   ${label}`)
  else {
    failures += 1
    console.error(`FAIL ${label}${detail === '' ? '' : `: ${detail}`}`)
  }
}

/** Scratch roots this test created; the only ones it may remove. */
const roots = []

/**
 * @param {string} tag - subdirectory name.
 * @returns {string} a fresh scratch root.
 */
function scratch(tag) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shadow-worker-'))
  roots.push(root)
  const dir = path.join(root, tag)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A home with a host log, plus the ledger path inside it.
 * @returns {{home: string, ledger: string, log: string}} the fake host's home.
 */
function makeHome() {
  const home = scratch('home')
  mkdirSync(path.join(home, 'logs'), { recursive: true })
  return {
    home,
    ledger: path.join(home, '.shadow-verify', 'ledger.jsonl'),
    log: path.join(home, 'logs', 'desktop-next.log'),
  }
}

/**
 * The host reporting its build, which is what a successful boot looks like.
 * @param {string} log - the host log path.
 * @param {string} [stamp] - the build stamp to report.
 * @returns {void}
 */
function hostReports(log, stamp = EXPECT) {
  appendFileSync(log, `2026-01-01T00:00:01.000Z [info] shadow: build ${stamp} over 6 files\n`)
}

// 1. The happy path: the app is already gone, the relaunch happens, the host
// reports the expected stamp. Everything is on the ledger.
{
  const { home, ledger, log } = makeHome()
  const launches = []
  const result = await runWorker({ home, ledger, expect: EXPECT, commit: COMMIT }, {
    isRunning: () => false,
    launch: (app) => { launches.push(app) },
    wait: async () => { hostReports(log); return { ok: true, detail: 'the host reported the expected build' } },
  })
  const stages = readLedger(ledger).filter((e) => e.kind === 'outcome').map((e) => `${e.stage}:${e.ok ? 'ok' : 'FAIL'}`)
  check('a clean round relaunches and confirms', result.ok && launches.length === 1, result.detail)
  check('both stages are on the ledger', stages.join(',') === 'relaunch:ok,verify:ok', stages.join(','))
}

// 2. An app that is still dying: the worker waits instead of launching a second
// instance on top of the first.
{
  const { home, ledger, log } = makeHome()
  let polls = 0
  const launches = []
  const result = await runWorker({ home, ledger, expect: EXPECT, commit: COMMIT }, {
    isRunning: () => { polls += 1; return polls < 3 },
    launch: (app) => { launches.push(app) },
    wait: async () => { hostReports(log); return { ok: true, detail: 'the host reported the expected build' } },
  })
  check('a dying app is waited out, not relaunched over', result.ok && launches.length === 1 && polls >= 3, `polls ${String(polls)}`)
}

// 3. An app that will not exit: no relaunch, and the ledger says so.
{
  const { home, ledger } = makeHome()
  const launches = []
  const result = await runWorker({ home, ledger, expect: EXPECT, commit: COMMIT }, {
    isRunning: () => true,
    launch: (app) => { launches.push(app) },
    wait: async () => ({ ok: true, detail: 'unreachable' }),
  })
  check('an app that will not exit never gets relaunched', !result.ok && launches.length === 0, result.detail)
  const last = readLedger(ledger).at(-1)
  check('the failure is on the ledger', last?.stage === 'relaunch' && last.ok === false)
}

// 4. A relaunch that throws is recorded rather than swallowed.
{
  const { home, ledger } = makeHome()
  const result = await runWorker({ home, ledger, expect: EXPECT, commit: COMMIT }, {
    isRunning: () => false,
    launch: () => { throw new Error('the executable is gone') },
    wait: async () => ({ ok: true, detail: 'unreachable' }),
  })
  check('a failed relaunch is recorded', !result.ok && result.detail.includes('the executable is gone'), result.detail)
}

// 5. A host that reports the wrong build is a failed round, not a silent one.
{
  const { home, ledger } = makeHome()
  const result = await runWorker({ home, ledger, expect: EXPECT, commit: COMMIT }, {
    isRunning: () => false,
    launch: () => {},
    wait: async () => ({ ok: false, detail: 'the host reported a different build' }),
  })
  check('a wrong build fails the round', !result.ok && readLedger(ledger).some((e) => e.stage === 'verify' && !e.ok), result.detail)
}

// 6. The exit wait itself is pure enough to test directly, including its timeout.
{
  const never = await waitForExit(() => true, 1_000)
  const atOnce = await waitForExit(() => false, 1_000)
  check('the exit wait gives up and reports it', never === false && atOnce === true)
}

// 7. The load-bearing property: the worker is started outside the host's process
// tree. WMI first, schtasks as the fallback, and never a direct child of the judge.
{
  const command = workerCommand({ home: 'C:\\DSH', ledger: 'C:\\DSH\\.shadow-verify\\ledger.jsonl', commit: COMMIT, expect: EXPECT })
  check('the worker command carries the expected stamp', command.includes(`--expect ${EXPECT}`), command)

  const calls = []
  const viaWmi = spawnWorkerOutsideTree(command, (file, args) => { calls.push([file, args]); return '0\n' })
  check('WMI is the first choice', viaWmi === 'wmi' && calls.length === 1 && calls[0][0] === 'powershell'
    && calls[0][1].join(' ').includes('Invoke-CimMethod'), calls.map((c) => c[0]).join(','))

  const fallback = []
  const viaTasks = spawnWorkerOutsideTree(command, (file, args) => {
    fallback.push([file, args])
    if (file === 'powershell') throw new Error('wmi is unavailable')
    return ''
  })
  check('schtasks is the fallback', viaTasks === 'schtasks' && fallback.length === 3
    && fallback[1][0] === 'schtasks' && fallback[1][1].includes('/create')
    && fallback[2][1].includes('/run'), fallback.map((c) => c[0]).join(','))

  const doomed = []
  const viaNone = spawnWorkerOutsideTree(command, (file, args) => { doomed.push([file, args]); throw new Error('no') })
  check('when both fail nothing is started as a plain child', viaNone === 'none'
    && !doomed.some(([file]) => file === 'node' || file === process.execPath), doomed.map((c) => c[0]).join(','))
}

// 8. The worker's own argument parsing refuses an incomplete invocation rather
// than starting with an empty expectation.
{
  let refused = false
  try {
    const { parseArgs } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'restart-host.mjs')).href)
    parseArgs(['--home', 'C:\\DSH', '--ledger', 'x'])
  } catch { refused = true }
  check('an incomplete worker invocation is refused', refused)
}

// Remove the scratch roots and nothing else.
for (const root of roots) {
  if (path.dirname(root) !== os.tmpdir()) {
    console.error(`FAIL refusing to clean outside the temp dir: ${root}`)
    failures += 1
    continue
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'restart host: all checks passed' : `restart host: ${String(failures)} failed`)
process.exitCode = failures === 0 ? 0 : 1
