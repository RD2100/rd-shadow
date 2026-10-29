#!/usr/bin/env node
/**
 * 重启 worker：在宿主的进程树之外，把应用杀掉、拉起，并核对它自报的构建戳。
 *
 * 为什么需要它：裁判（verify-and-restart.mjs）自己跑在宿主的进程树里——宿主是它所有
 * 祖先进程中的一个。所以裁判一旦 taskkill 应用，自己也会跟着死，死在拉起应用之前。
 * 0.7.1 实测过这个形状：判定通过、worker 也起来了，但裁判的 taskkill 连它自己一起收掉，
 * 60 秒后 worker 看到应用还活着，整轮以「应用不退」告终。
 *
 * 于是三件事都归 worker：杀、拉、核对。它由 WMI（`Invoke-CimMethod Win32_Process Create`）
 * 或计划任务服务承载，都不在宿主的进程树里，所以它的 taskkill 能跑完。
 *
 * 它做四件事：等一个没人说话的空档 → 杀应用并等它退 → 拉起应用 →
 * 等宿主日志出现 `shadow: build <期望戳>`（撞见 `did not activate` 即失败，超时即失败）。
 *
 * 四个动作（杀、应用是否在跑、拉起、等日志）加上「等空档」都是可注入的探针，
 * 否则这套逻辑没法离线测。
 *
 * 用法：node scripts/restart-host.mjs --expect <hash> --ledger <path> --home <dsh-home> --commit <sha>
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { appendLedger, hostLog, waitForHost } from './verify-and-restart.mjs'

const APP_IMAGE = 'DSH NEXT.exe'
const APP_EXE = 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe'
/** 等应用退出的最长时间。taskkill /F 之后通常几百毫秒；给到一分钟是给慢机器留余量。 */
const EXIT_TIMEOUT_MS = 60_000
const EXIT_POLL_MS = 500
/** 轮询间隔：等空档、等退出、等宿主自报共用。 */
const POLL_MS = 2_000
/**
 * 默认要等多久的安静，才认为「这一轮对话说完了」。
 *
 * 插件和正在跑的对话住在同一个宿主进程里，杀掉宿主就是打断当前这一轮。
 * 裁判是被我在一轮对话里调起来的，所以等日志安静下来，就是等这一轮说完。
 * 宿主空闲时一条日志都不写（实测 08:42–09:33 零行），所以「安静」是可靠的空档信号。
 */
const QUIET_MS = 120_000
/** 等空档的上限。一直有人说话就按这个上限动手，并在流水里说明是没等到。 */
const MAX_WAIT_MS = 900_000

/**
 * 应用是否在跑。
 * @returns {boolean} 桌面上有 DSH NEXT 的进程时为 true。
 */
function isRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${APP_IMAGE}`, '/NH'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.includes(APP_IMAGE)
  } catch {
    return false
  }
}

/**
 * 杀应用。Electron 会开一串进程，只关主窗口会留下孤儿渲染进程，而它们也持着旧代码，
 * 所以连子进程一起收。/T 会把调用方的整个树都收掉——这正是它必须在进程树外执行的原因。
 * @returns {void}
 */
function killApp() {
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', APP_IMAGE], { stdio: 'ignore' })
  } catch {
    // 本来就没在跑：不是失败，只是没什么可杀。
  }
}

/**
 * 拉起应用。走 `cmd /c start` 而不是直接 spawn：多一层 cmd 之后新进程不继承本进程的句柄。
 * @param {string} app - 可执行文件路径。
 * @returns {void}
 */
function launchApp(app) {
  execFileSync('cmd', ['/c', 'start', '', app], { stdio: 'ignore', timeout: 30_000 })
}

/** 默认探针。 */
const defaultProbes = () => ({
  kill: () => { killApp() },
  isRunning,
  launch: (app) => { launchApp(app) },
  wait: (home, expected, since) => waitForHost(home, expected, since),
  quiet: (home, quietMs, maxWaitMs) => waitForQuiet(home, quietMs, maxWaitMs),
})

/**
 * 留一行流水。小本本记结局，这里记过程——两者合起来才能在"应用没起来"时看出卡在哪。
 * @param {string} home - DSH 主目录。
 * @param {string} message - 一行说明。
 * @returns {void}
 */
function note(home, message) {
  const dir = path.join(home, '.shadow-verify')
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'restart-host.log'), `${new Date().toISOString()}  ${message}\n`)
  } catch {
    // 流水写不出来不影响正事：结局还在小本本里。
  }
}

/**
 * 等应用退出。它可能还没死透（taskkill 刚发出），也可能本来就没在跑。
 * @param {() => boolean} isRunning - 探针。
 * @param {number} timeoutMs - 最长时间。
 * @returns {Promise<boolean>} 退了吗。
 */
async function waitForExit(isRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!isRunning()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => { setTimeout(resolve, EXIT_POLL_MS) })
  }
}

/**
 * 等一个「没人说话」的空档再动手。
 *
 * 为什么要等：插件和正在跑的对话住在同一个宿主进程里（裁判和我都是它的后代），
 * 所以杀掉宿主就是打断当前这一轮对话。等日志安静下来，就是等这一轮说完——
 * 宿主在空闲时一条日志都不写（实测：08:42 到 09:33 之间零行）。
 * 等不到就按上限动手，并在流水里说明是没等到。
 * @param {string} home - DSH 主目录。
 * @param {number} quietMs - 要安静这么久才算空档。
 * @param {number} maxWaitMs - 最多等这么久。
 * @returns {Promise<string>} 一句话说明等到了什么。
 */
async function waitForQuiet(home, quietMs, maxWaitMs) {
  const file = hostLog(home)
  const deadline = Date.now() + maxWaitMs
  let seen = { size: -1, mtime: -1 }
  let quietSince = Date.now()
  for (;;) {
    let now = { size: -1, mtime: -1 }
    if (existsSync(file)) {
      const stat = statSync(file)
      now = { size: stat.size, mtime: stat.mtimeMs }
    }
    if (now.size !== seen.size || now.mtime !== seen.mtime) {
      seen = now
      quietSince = Date.now()
    }
    if (Date.now() - quietSince >= quietMs) {
      return `the host log had been quiet for ${String(quietMs / 1000)}s`
    }
    if (Date.now() > deadline) {
      return `the log never stayed quiet for ${String(quietMs / 1000)}s; killing anyway after ${String(maxWaitMs / 1000)}s`
    }
    await sleep(POLL_MS)
  }
}

/**
 * 跑完一轮：等空档 → 杀并等它退 → 拉起 → 核对。
 * @param {{home: string, ledger: string, expect: string, commit: string, app?: string, quietMs?: number, maxWaitMs?: number}} options - 参数。
 * @param {{kill?: () => void, isRunning?: () => boolean, launch?: (app: string) => void, wait?: Function, quiet?: Function}} [probes] - 探针，测试注入假的。
 * @returns {Promise<{ok: boolean, detail: string}>} 结局。
 */
async function runWorker(options, probes) {
  const p = { ...defaultProbes(), ...probes }
  const app = options.app ?? APP_EXE
  const record = (ok, stage, detail) => {
    appendLedger(options.ledger, { kind: 'outcome', commit: options.commit, ok, stage, detail })
    note(options.home, `${ok ? 'ok  ' : 'FAIL'} ${stage}: ${detail}`)
    return { ok, detail }
  }

  const quietMs = options.quietMs ?? QUIET_MS
  note(options.home, `worker started; expecting build ${options.expect}; waiting for a quiet ${String(quietMs / 1000)}s so no turn is cut in half`)
  const quiet = await p.quiet(options.home, quietMs, options.maxWaitMs ?? MAX_WAIT_MS)
  note(options.home, quiet)

  // 杀。裁判不做这一下——它在宿主的进程树里，taskkill 连它自己一起收掉，
  // 0.7.1 就是这么整轮报废的。worker 在树外，它的 taskkill 才跑得完。
  //
  // 截止时刻取在杀之前：此后的构建戳行只可能来自新起来的那一个（或是一次我们
  // 逼出来的重载）。按字节偏移量切是行不通的——宿主日志是带容量上限的滚动文件，
  // 0.7.2 实测过：偏移量取在 131136，滚动后文件还是 131136，从那之后读到的是空，
  // 而宿主三秒前就自报过了，整轮被判成假失败。时间戳不受滚动影响。
  const since = new Date().toISOString()
  if (p.isRunning()) {
    try {
      p.kill()
    } catch (error) {
      return record(false, 'relaunch', `the kill itself failed — ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!(await waitForExit(p.isRunning, EXIT_TIMEOUT_MS))) {
      return record(false, 'relaunch', `the app did not exit within ${String(EXIT_TIMEOUT_MS / 1000)}s`)
    }
  }

  try {
    p.launch(app)
  } catch (error) {
    return record(false, 'relaunch', `the relaunch itself failed — ${error instanceof Error ? error.message : String(error)}`)
  }
  note(options.home, 'the app was relaunched; waiting for it to report its build')
  record(true, 'relaunch', 'the app was relaunched')

  const result = await p.wait(options.home, options.expect, since)
  return record(result.ok, 'verify', result.detail)
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 到点兑现。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 读参数。与裁判同一套短风格。
 * @param {string[]} argv - 参数。
 * @returns {{home: string, ledger: string, expect: string, commit: string, app?: string, quietMs?: number, maxWaitMs?: number}} 解析结果。
 */
function parseArgs(argv) {
  const out = { home: '', ledger: '', expect: '', commit: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') out.home = argv[++i]
    else if (arg === '--ledger') out.ledger = argv[++i]
    else if (arg === '--expect') out.expect = argv[++i]
    else if (arg === '--commit') out.commit = argv[++i]
    else if (arg === '--app') out.app = argv[++i]
    else if (arg === '--quiet-ms') out.quietMs = Number(argv[++i])
    else if (arg === '--max-wait-ms') out.maxWaitMs = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (out.home === '' || out.ledger === '' || out.expect === '') {
    throw new Error('--home, --ledger and --expect are all required')
  }
  return out
}

/**
 * 入口。同样只有被直接跑时才出手，测试 import 时不启动。
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await runWorker(options)
  console.log(`${result.ok ? 'ok' : 'not ok'}: ${result.detail}`)
  if (!result.ok) process.exitCode = 1
}

export { isRunning, parseArgs, runWorker, waitForExit, waitForQuiet }

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) await main()
