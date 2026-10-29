#!/usr/bin/env node
/**
 * 重启 worker：在宿主的进程树之外把应用拉起来，并核对它自报的构建戳。
 *
 * 为什么需要它：裁判（verify-and-restart.mjs）自己跑在宿主的进程树里——宿主是它所有
 * 祖先进程中的一个。所以裁判一旦 taskkill 应用，自己也会跟着死，死在拉起应用之前。
 * 于是重启与核对必须交给一个不在那棵树里的进程：本文件由 WMI 或计划任务服务承载，
 * 裁判把它起到树外，然后才 taskkill。裁判死掉没关系，worker 会收尾，并把每一阶段
 * 写进小本本——重启被打断、应用没起来，都在账上看得见。
 *
 * 它做四件事：等应用退出 → 拉起应用 → 等宿主日志出现 `shadow: build <期望戳>`
 * （撞见 `did not activate` 即失败，超时即失败）→ 退出码 0/1。
 *
 * 三个动作（应用是否在跑、拉起、等日志）都是可注入的探针，否则这套逻辑没法离线测。
 *
 * 用法：node scripts/restart-host.mjs --expect <hash> --ledger <path> --home <dsh-home> --commit <sha>
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { appendLedger, waitForHost } from './verify-and-restart.mjs'

const APP_IMAGE = 'DSH NEXT.exe'
const APP_EXE = 'C:\\Program Files\\DSH NEXT\\DSH NEXT.exe'
/** 等应用退出的最长时间。taskkill /F 之后通常几百毫秒；给到一分钟是给慢机器留余量。 */
const EXIT_TIMEOUT_MS = 60_000
const EXIT_POLL_MS = 500

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
 * 拉起应用。走 `cmd /c start` 而不是直接 spawn：多一层 cmd 之后新进程不继承本进程的句柄。
 * @param {string} app - 可执行文件路径。
 * @returns {void}
 */
function launchApp(app) {
  execFileSync('cmd', ['/c', 'start', '', app], { stdio: 'ignore', timeout: 30_000 })
}

/** 默认探针。 */
const defaultProbes = () => ({
  isRunning,
  launch: (app) => { launchApp(app) },
  wait: (home, expected, from) => waitForHost(home, expected, from),
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
 * 跑完一轮：等退出 → 拉起 → 核对。
 * @param {{home: string, ledger: string, expect: string, commit: string, app?: string, readyMs?: number}} options - 参数。
 * @param {{isRunning?: () => boolean, launch?: (app: string) => void, wait?: Function}} [probes] - 探针，测试注入假的。
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

  note(options.home, `worker started; expecting build ${options.expect}`)
  if (!(await waitForExit(p.isRunning, EXIT_TIMEOUT_MS))) {
    return record(false, 'relaunch', `the app did not exit within ${String(EXIT_TIMEOUT_MS / 1000)}s`)
  }

  try {
    p.launch(app)
  } catch (error) {
    return record(false, 'relaunch', `the relaunch itself failed — ${error instanceof Error ? error.message : String(error)}`)
  }
  note(options.home, 'the app was relaunched; waiting for it to report its build')
  record(true, 'relaunch', 'the app was relaunched')

  // 从"应用已经不在"这一刻算起：此后的构建戳行只可能来自新起来的那一个。
  const from = 0
  const result = await p.wait(options.home, options.expect, from)
  return record(result.ok, 'verify', result.detail)
}

/**
 * 读参数。与裁判同一套短风格。
 * @param {string[]} argv - 参数。
 * @returns {{home: string, ledger: string, expect: string, commit: string, app?: string}} 解析结果。
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

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()

export { isRunning, parseArgs, runWorker, waitForExit }
