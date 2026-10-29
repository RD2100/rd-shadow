#!/usr/bin/env node
/**
 * 验证裁判。
 *
 * 它做什么：全自动地走完「该重启吗」和「重启生效了吗」两问，中间那一下重启也由它做。
 *
 *   1. 「现在允许重启吗」——部署副本的每一个字节，是否都等于某个明确指定的 git 提交
 *      里的同一个文件。这一条是承重墙：它按内容寻址，所以往部署副本里塞字节、改工作树、
 *      加一个提交里没有的模块，都过不了。唯一能让裁判放行的办法是让那个提交本身包含
 *      这些字节——而那是一次可审计的开发动作，提交还推到 origin 上留痕。
 *   2. 「重启真的生效了吗」——宿主自己在日志里报的 `shadow: build <hash>`，是不是就是
 *      那个提交的构建戳，且没有 `did not activate`。这是宿主自报「我加载的是哪些字节」，
 *      比时间序、比任何推断都硬。
 *
 * 关于那一下重启：产品自带的两条路（托盘「退出并重启」、设置 API 的 restart）都要人点
 * 确认，原话是「正在运行的任务会中断」——它要人确认的是「现在没有要紧任务在跑」。
 * 开发环里这个确认由裁判代做：判定通过意味着部署副本等于一个明确提交，而此时唯一在跑的
 * 任务就是刚刚改完代码的那个。代价说清楚：这条路比产品自带的粗糙，它不等应用体面退出，
 * 所以万一有别的任务在跑，会被硬断。要体面那一下，就自己点托盘，然后用 verify 子命令
 * 让裁判核对。
 *
 * 裁判自己跑在宿主的进程树里，所以它不杀进程：杀、拉、核对三件事都交给
 * `scripts/restart-host.mjs`，那个 worker 由 WMI 或计划任务服务承载，不在树里，
 * 它的 taskkill 才跑得完。裁判起完 worker 就返回，随后被那一下 taskkill 收掉——
 * 这是设计，不是事故；结局由 worker 写进小本本。
 *
 * 用法：
 *   node scripts/verify-and-restart.mjs arm --commit <sha>   记账：这一轮要加载的提交（默认 HEAD）
 *   node scripts/verify-and-restart.mjs                       全自动：判定 → 通过就把重启交给 worker
 *   node scripts/verify-and-restart.mjs judge                 只判定「允许重启吗」
 *   node scripts/verify-and-restart.mjs verify                只核对「宿主加载对了吗」
 *   node scripts/verify-and-restart.mjs live                  不重启：只核对守卫此刻生效的是哪一份核
 *   node scripts/verify-and-restart.mjs watch                 挂上之后：每个新 arm 自己跑完全程
 *   node scripts/verify-and-restart.mjs status                看小本本
 *
 * `live` 是 0.8.0 加的那条路。只改判断核（lib/dispatch-core.js）时宿主根本不必重启：
 * 守卫每 5 秒看一眼磁盘，字节变了就换上并在日志里自报 `shadow: live core <hash>`。
 * live 核对的就是那一行，所以改规则不再打断任何对话。改了宿主半边（注册、工具、
 * 补丁、版本号）仍然必须走重启那条路。
 *
 * 跑完默认动作后，杀进程与核对都在 worker 手里，裁判活不过那一下 taskkill；
 * 用 `status` 看 relaunch 与 verify 两行的结局。
 *
 * 测试与 CI 走 judge/--dry-run，不碰进程、不读宿主日志之外的东西。
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGE = 'dsh-plugin-shadow'
/** 兜底那条路（schtasks）用的任务名，worker 结束时会删掉它。 */
const TASK_NAME = 'dsh-shadow-restart-host'
/** 等宿主自报构建戳的最长时间。冷启动加挂载，实测几秒；给到三分钟是给慢机器留余量。 */
const READY_TIMEOUT_MS = 180_000
const POLL_MS = 2_000

/**
 * 读参数。刻意做得很短：这个脚本只有几个动作，不需要参数框架。
 * @param {string[]} argv - 进程参数。
 * @returns {{action: string, dryRun: boolean, commit?: string, deployed?: string, ledger?: string, dshHome?: string}} 解析结果。
 */
function parseArgs(argv) {
  const out = { action: 'all', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--commit') out.commit = argv[++i]
    else if (arg === '--deployed') out.deployed = argv[++i]
    else if (arg === '--ledger') out.ledger = argv[++i]
    else if (arg === '--dsh-home') out.dshHome = argv[++i]
    else if (arg === '--repo-root') out.repoRoot = argv[++i]
    else if (['arm', 'judge', 'verify', 'live', 'all', 'watch', 'status'].includes(arg)) out.action = arg
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

/**
 * DSH 主目录。日志、active-run.json、部署副本都在它下面。
 * @param {string | undefined} explicit - 命令行给的显式值。
 * @returns {string} 主目录绝对路径。
 */
function dshHome(explicit) {
  return path.resolve(explicit ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.DSH'))
}

/**
 * 部署副本目录：桌面 profile 里装着的那个包。
 * @param {string} home - DSH 主目录。
 * @param {string | undefined} explicit - 命令行给的显式值。
 * @returns {string} 部署副本绝对路径。
 */
function deployedDir(home, explicit) {
  return path.resolve(explicit ?? path.join(home, 'profiles', 'desktop', 'node_modules', PACKAGE))
}

/**
 * 小本本：一行一条 JSON，只追加。放在 DSH 主目录旁边，不进仓库——
 * 它记的是本机状态，不是代码。
 * @param {string} home - DSH 主目录。
 * @param {string | undefined} explicit - 命令行给的显式值。
 * @returns {string} 小本本路径。
 */
function ledgerPath(home, explicit) {
  return path.resolve(explicit ?? path.join(home, '.shadow-verify', 'ledger.jsonl'))
}

/**
 * @param {string} file - 小本本路径。
 * @returns {object[]} 全部条目，文件不存在时是空数组。
 */
function readLedger(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * @param {string} file - 小本本路径。
 * @param {object} entry - 要追加的条目。
 * @returns {void}
 */
function appendLedger(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

/**
 * 从 git 里取某个提交的某个文件。git 对象按内容寻址，所以「提交里有什么」
 * 不受工作树、不受部署副本、也不受后来提交的影响。
 * @param {string} commit - 提交 SHA。
 * @param {string} file - 仓库内的文件路径。
 * @param {string} [repoRoot] - 仓库根目录，测试里传临时仓库。
 * @returns {Buffer | null} 文件内容；提交或文件不存在时为 null。
 */
function gitShow(commit, file, repoRoot = REPO_ROOT) {
  try {
    return execFileSync('git', ['show', `${commit}:${file}`], {
      cwd: repoRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/**
 * @param {string} commit - 提交 SHA。
 * @param {string} dir - 仓库内的目录，如 `lib`。
 * @param {string} [repoRoot] - 仓库根目录，测试里传临时仓库。
 * @returns {string[]} 该提交里这个目录下的全部文件路径。
 */
function gitList(commit, dir, repoRoot = REPO_ROOT) {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', commit, dir], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n').filter(Boolean)
}

/**
 * @param {Buffer | string} bytes - 内容。
 * @returns {string} SHA-256 十六进制。
 */
function hashOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {string} file - 文件路径。
 * @returns {Buffer | null} 文件内容；不存在时为 null。
 */
function readIfExists(file) {
  return existsSync(file) ? readFileSync(file) : null
}

/**
 * 判定。每一条都独立报告，但第一条不成立就不再往后判——
 * 一个不存在的提交没法作为「应该加载什么」的答案。
 * @param {string} commit - 记在账上的提交。
 * @param {string} target - 部署副本目录。
 * @param {string} [repoRoot] - 仓库根目录，测试里传临时仓库。
 * @returns {{ok: boolean, checks: {name: string, ok: boolean, detail: string}[]}} 判定结果。
 */
function judge(commit, target, repoRoot = REPO_ROOT) {
  const checks = []
  const record = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok }

  let head = ''
  try {
    head = execFileSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    head = ''
  }
  if (!record('commit resolves', head === commit, `git resolves ${commit} to ${head || 'nothing'}`)) {
    return { ok: false, checks }
  }

  if (!record('deployed copy exists', existsSync(path.join(target, 'package.json')), target)) {
    return { ok: false, checks }
  }

  // lib/：逐个比，并且两边文件名集合必须相同——多一个提交里没有的模块，
  // 正是「塞一个自己的守卫进去」的形状，只比共同文件会漏掉它。
  const expected = new Map()
  for (const file of gitList(commit, 'lib', repoRoot)) expected.set(file, gitShow(commit, file, repoRoot))
  const expectedNames = [...expected.keys()].map((file) => path.basename(file)).sort()
  const present = existsSync(path.join(target, 'lib'))
    ? readdirSync(path.join(target, 'lib')).filter((name) => name.endsWith('.js')).sort()
    : []
  if (!record('module set matches', JSON.stringify(present) === JSON.stringify(expectedNames),
    `deployed [${present}] vs commit [${expectedNames}]`)) {
    return { ok: false, checks }
  }
  for (const [file, bytes] of expected) {
    if (bytes === null) continue
    const there = readIfExists(path.join(target, file))
    const ok = there !== null && hashOf(there) === hashOf(bytes)
    if (!record(`bytes match: ${file}`, ok,
      ok ? hashOf(bytes).slice(0, 12) : `deployed ${there === null ? 'missing' : hashOf(there).slice(0, 12)} vs commit ${hashOf(bytes).slice(0, 12)}`)) {
      return { ok: false, checks }
    }
  }

  // cordis.patch.yml：宿主启动时读它，它决定守卫怎么接线，所以它和 lib 一样承重。
  const patch = gitShow(commit, 'cordis.patch.yml', repoRoot)
  const patchThere = readIfExists(path.join(target, 'cordis.patch.yml'))
  if (!record('bytes match: cordis.patch.yml',
    patch !== null && patchThere !== null && hashOf(patch) === hashOf(patchThere),
    patch === null || patchThere === null ? 'missing on one side' : hashOf(patch).slice(0, 12))) {
    return { ok: false, checks }
  }

  // 版本号：便宜，但能把「同步漏了一半」这种形状提前挡下来。
  const pkg = gitShow(commit, 'package.json', repoRoot)
  const pkgThere = readIfExists(path.join(target, 'package.json'))
  const want = pkg === null ? null : JSON.parse(pkg.toString('utf8')).version
  const got = pkgThere === null ? null : JSON.parse(pkgThere.toString('utf8')).version
  if (!record('version matches', want !== null && want === got, `deployed ${got} vs commit ${want}`)) {
    return { ok: false, checks }
  }

  return { ok: true, checks }
}

/**
 * 某个提交的构建戳。不重新实现哈希算法——把那个提交的 lib/ 落到临时目录，
 * 让仓库自己的 build-stamp.js 去算，裁判和宿主才不可能各算各的。
 * @param {string} commit - 提交 SHA。
 * @param {string} [repoRoot] - 仓库根目录，测试里传临时仓库。
 * @returns {Promise<string | null>} 构建戳；算不出来时为 null。
 */
async function expectedHash(commit, repoRoot = REPO_ROOT) {
  const stage = path.join(os.tmpdir(), `shadow-judge-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(path.join(stage, 'lib'), { recursive: true })
    for (const file of gitList(commit, 'lib', repoRoot)) {
      const bytes = gitShow(commit, file, repoRoot)
      if (bytes !== null) writeFileSync(path.join(stage, file), bytes)
    }
    const mod = await import(pathToFileURL(path.join(stage, 'lib', 'build-stamp.js')).href)
    return mod.buildStamp()?.hash ?? null
  } catch {
    return null
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * 部署副本的构建戳。同一套算法，只是算的是磁盘上那份。
 * @param {string} target - 部署副本目录。
 * @returns {Promise<string | null>} 构建戳；算不出来时为 null。
 */
async function deployedHash(target) {
  try {
    const mod = await import(pathToFileURL(path.join(target, 'lib', 'build-stamp.js')).href)
    return mod.buildStamp()?.hash ?? null
  } catch {
    return null
  }
}

/**
 * @param {string} home - DSH 主目录。
 * @returns {string} 宿主日志路径。
 */
function hostLog(home) {
  return path.join(home, 'logs', 'desktop-next.log')
}

/**
 * 一行日志的时间戳。多行堆栈的续行没有时间戳，返回空串——它们排在时间线之外，
 * 反正要判据的两行（构建戳、did not activate）都带时间戳。
 * @param {string} line - 一行日志。
 * @returns {string} ISO 时间戳，或空串。
 */
function lineTime(line) {
  const found = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(line)
  return found === null ? '' : found[1]
}

/**
 * 只留某个时刻之后的行。
 *
 * 为什么不能按字节偏移量切：宿主日志是**带容量上限的滚动文件**。重启时它被重写过一遍，
 * 新旧内容的总字节数几乎一样大——0.7.2 实测过：偏移量取在 131136，滚动后文件还是
 * 131136，`偏移量 <= 文件大小` 成立，于是从那之后读，读到的是空；而宿主 3 秒前就已经
 * 自报过构建戳了。整轮判成假失败。时间戳不受滚动、截断、按天切分影响。
 * @param {string} text - 整个日志文件。
 * @param {string} since - ISO 时间戳；空串表示不切。
 * @returns {string} 切之后的行。
 */
function afterCutoff(text, since) {
  if (since === '') return text
  return text.split('\n').filter((line) => lineTime(line) >= since).join('\n')
}

/**
 * 等宿主自报。判据全在它自己的日志里，不猜：`shadow: build <hash>` 是宿主说
 * 「我加载的是哪些文件」，`did not activate` 是它说「有一行没挂上」。
 * 两者都必须发生在截止时刻之后，否则读到的是上一轮的行。
 * @param {string} home - DSH 主目录。
 * @param {string} expected - 期望的构建戳。
 * @param {string} [since] - 截止时刻（ISO）；空串表示整份日志都算。
 * @returns {Promise<{ok: boolean, detail: string}>} 核对结果。
 */
async function waitForHost(home, expected, since = '') {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = 'waiting for the host to report'
  while (Date.now() < deadline) {
    const file = hostLog(home)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const fresh = afterCutoff(text, since)
    if (fresh.includes('did not activate')) return { ok: false, detail: 'the host logged "did not activate" after the restart' }
    if (fresh.includes(`shadow: build ${expected} `)) return { ok: true, detail: `the host reported build ${expected}` }
    last = fresh.length === 0 ? 'no new log lines yet' : 'new log lines, but no build stamp yet'
    await sleep(POLL_MS)
  }
  return { ok: false, detail: `${last}; gave up after ${READY_TIMEOUT_MS / 1000}s` }
}

/**
 * 一次判定：把结论写进小本本，返回给命令行。
 * @param {object} options - 运行参数。
 * @param {string} home - DSH 主目录。
 * @param {string} ledger - 小本本路径。
 * @param {{commit: string}} armed - 当前记着的那一条。
 * @returns {Promise<{ok: boolean, detail: string, stage: string}>} 结局。
 */
async function runJudge(options, home, ledger, armed) {
  const target = deployedDir(home, options.deployed)
  const result = judge(armed.commit, target, options.repoRoot)
  if (!result.ok) {
    const failed = result.checks.find((check) => !check.ok)
    const detail = `${failed.name}: ${failed.detail}`
    if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: false, stage: 'judge', detail, checks: result.checks })
    return { ok: false, detail, stage: 'judge' }
  }
  const hash = await deployedHash(target)
  const detail = `every byte matches ${armed.commit.slice(0, 7)}; deployed stamp ${hash ?? 'unavailable'}`
  if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: true, stage: 'judge', detail, checks: result.checks })
  return { ok: true, detail, stage: 'judge' }
}

/**
 * 一次核对：等宿主自己说「我加载的就是这些字节」。
 * @param {object} options - 运行参数。
 * @param {string} home - DSH 主目录。
 * @param {string} ledger - 小本本路径。
 * @param {{commit: string, since?: string}} armed - 当前记着的那一条。
 * @returns {Promise<{ok: boolean, detail: string, stage: string}>} 结局。
 */
async function runVerify(options, home, ledger, armed) {
  const expected = await expectedHash(armed.commit, options.repoRoot)
  if (expected === null) {
    const detail = 'cannot compute the expected build stamp from that commit'
    if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: false, stage: 'verify', detail })
    return { ok: false, detail, stage: 'verify' }
  }
  const result = await waitForHost(home, expected, typeof armed.since === 'string' ? armed.since : '')
  if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: result.ok, stage: 'verify', detail: result.detail })
  return { ...result, stage: 'verify' }
}

/**
 * 部署副本里判断核的哈希。和 expectedHash 不同：那个把某个提交的 lib/ 落到临时
 * 目录让 build-stamp.js 算整目录的戳，这里只算一个文件——热换换的就是这一个文件，
 * 判据也必须精确到这一个文件。
 * @param {string} target - 部署副本目录。
 * @returns {string | null} 12 位十六进制；读不到时为 null。
 */
function coreHashOf(target) {
  const file = path.join(target, 'lib', 'dispatch-core.js')
  const bytes = readIfExists(file)
  return bytes === null ? null : hashOf(bytes).slice(0, 12)
}

/**
 * 等守卫自报「我现在生效的是这一份核」。
 *
 * 这一行只在核真的换过之后才出现：`shadow: live core <hash> (was <old>)`。
 * 没换过就没有行——而那正是想要的结果（生效的本来就是对的字节），所以判据是
 * 「截止时刻之后最后一行 live core 等于期望值」，没有行也算不过，并说清原因。
 * @param {string} home - DSH 主目录。
 * @param {string} expected - 期望的核哈希。
 * @param {string} [since] - 截止时刻（ISO）；空串表示整份日志都算。
 * @returns {Promise<{ok: boolean, detail: string}>} 核对结果。
 */
async function waitForLiveCore(home, expected, since = '') {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let last = 'waiting for the guard to report its live core'
  while (Date.now() < deadline) {
    const file = hostLog(home)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const fresh = afterCutoff(text, since)
    const found = [...fresh.matchAll(/shadow: live core ([0-9a-f]{12})/g)]
    if (found.length > 0) {
      const reported = found[found.length - 1][1]
      if (reported === expected) {
        return { ok: true, detail: `the guard is running core ${expected} without a restart` }
      }
      last = `the guard is running core ${reported}, not ${expected}`
    } else {
      last = fresh.length === 0 ? 'no new log lines yet' : 'new log lines, but the guard has not reported a live core yet'
    }
    await sleep(POLL_MS)
  }
  return { ok: false, detail: `${last}; gave up after ${READY_TIMEOUT_MS / 1000}s` }
}

/**
 * 一次核对：不重启，只看现在生效的是哪一份字节。
 *
 * 判据是部署副本自己的 lib/dispatch-core.js，不是某个提交——因为这一条路回答的
 * 问题是「宿主此刻在跑什么」，而字节在磁盘上，不在 git 里。想连「这些字节确实
 * 来自那个提交」一起问，先跑 judge。
 * @param {object} options - 运行参数。
 * @param {string} home - DSH 主目录。
 * @param {string} ledger - 小本本路径。
 * @param {{commit: string, since?: string}} armed - 当前记着的那一条。
 * @returns {Promise<{ok: boolean, detail: string, stage: string}>} 结局。
 */
async function runLive(options, home, ledger, armed) {
  const target = deployedDir(home, options.deployed)
  const expected = coreHashOf(target)
  if (expected === null) {
    const detail = 'cannot read lib/dispatch-core.js from the deployed copy'
    if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: false, stage: 'live', detail })
    return { ok: false, detail, stage: 'live' }
  }
  const result = await waitForLiveCore(home, expected, typeof armed.since === 'string' ? armed.since : '')
  if (!options.dryRun) appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: result.ok, stage: 'live', detail: result.detail })
  return { ...result, stage: 'live' }
}

/**
 * @param {object} options - 运行参数。
 * @returns {Promise<{home: string, ledger: string, armed?: {commit: string}}>} 环境与当前记着的那一条。
 */
function context(options) {
  const home = dshHome(options.dshHome)
  const ledger = ledgerPath(home, options.ledger)
  const entries = readLedger(ledger)
  const armed = [...entries].reverse().find((entry) => entry.kind === 'arm')
  return { home, ledger, armed }
}

/**
 * 还没走完流程的那一条 arm。watch 只对新的一条动手——否则同一个提交会被反复重启，
 * 而每一次重启都会打断正在跑的任务。
 * @param {object[]} entries - 小本本全部条目。
 * @returns {{commit: string} | undefined} 待处理的那一条，没有时为 undefined。
 */
function pendingArm(entries) {
  const armed = [...entries].reverse().find((entry) => entry.kind === 'arm')
  if (armed === undefined) return undefined
  const settled = entries.some((entry) => entry.kind === 'outcome' && entry.stage === 'verify' && entry.commit === armed.commit)
  return settled ? undefined : armed
}

/**
 * 全自动的一轮：判定 → 通过就重启 → 等宿主自认。任何一步不过，后面的都不做，
 * 并且每一步都写进小本本——重启被打断、宿主没起来，都能在账上看见。
 * @param {object} options - 运行参数。
 * @param {string} home - DSH 主目录。
 * @param {string} ledger - 小本本路径。
 * @param {{commit: string}} armed - 当前记着的那一条。
 * @param {(home: string) => void} [restart] - 重启动作，测试注入假的。
 * @returns {Promise<{ok: boolean, detail: string, stage: string}>} 结局。
 */
async function runAll(options, home, ledger, armed, restart = restartApp) {
  const judged = await runJudge(options, home, ledger, armed)
  if (!judged.ok) return { ok: false, detail: `refused to restart — ${judged.detail}`, stage: 'judge' }
  if (options.dryRun) return { ok: true, detail: `${judged.detail} (dry run: nothing was restarted)`, stage: 'judge' }

  const expected = await expectedHash(armed.commit, options.repoRoot)
  try {
    restart({ home, ledger, commit: armed.commit, expect: expected ?? '' })
  } catch (error) {
    const detail = `the restart itself failed — ${messageOf(error)}`
    appendLedger(ledger, { kind: 'outcome', commit: armed.commit, ok: false, stage: 'restart', detail })
    return { ok: false, detail, stage: 'restart' }
  }
  appendLedger(ledger, {
    kind: 'outcome',
    commit: armed.commit,
    ok: true,
    stage: 'restart',
    detail: 'the worker was started outside the host process tree; it kills, relaunches and verifies',
  })
  // 之后的事不在裁判手里：worker 会杀掉这个进程树，裁判活不过那一下。
  // 结局由 worker 写进小本本，`npm run judge status` 能看到。
  return { ok: true, detail: 'restart delegated to the worker; see the ledger for relaunch and verify', stage: 'restart' }
}

/**
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 到点兑现。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * @param {unknown} error - 抓到的异常。
 * @returns {string} 一句话说明，供记进小本本。
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 应用是否在跑。
 * @returns {boolean} 有 DSH NEXT 的进程时为 true。
 */
function isAppRunning() {
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
 * 杀掉桌面应用的所有进程。Electron 会开一串进程，只关主窗口会留下孤儿渲染进程，
 * 而它们也持着旧代码，所以连子进程一起收。
 * @returns {void}
 */
function killApp() {
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', APP_IMAGE], { stdio: 'ignore' })
  } catch {
    // 本来就没在跑：不是失败，只是没什么可杀。
  }
  const deadline = Date.now() + 60_000
  while (isAppRunning()) {
    if (Date.now() > deadline) throw new Error(`${APP_IMAGE} did not exit within 60s`)
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'ignore' })
  }
}

/**
 * 重新拉起应用。走 `cmd /c start` 而不是直接 spawn：多一层 cmd 之后，
 * 新进程不继承本进程的句柄——宿主若把子进程放进 job object，
 * 直接 spawn 出来的应用会跟着裁判一起被收掉。
 * @returns {void}
 */
function launchApp() {
  execFileSync('cmd', ['/c', 'start', '', APP_EXE], { stdio: 'ignore', timeout: 30_000 })
}

/**
 * 那一下重启。见文件头：产品自带的路径都要人确认「现在没有要紧任务在跑」，
 * 开发环里这个确认由判定代做；代价是它不等应用体面退出。
 *
 * 只起 worker，不杀。裁判跑在宿主的进程树里，它的 taskkill 会连它自己一起收掉——
 * 0.7.1 实测过：判定通过、worker 也起来了，但裁判的 taskkill 半路把自己杀掉，
 * 60 秒后 worker 看到应用还活着，整轮报废。所以杀、拉、核对三件事都归 worker，
 * 裁判把自己会死这件事变成设计而不是事故。
 * 测试注入一个假的进来，于是「判定不过就绝不动手」这条也能被钉住。
 * @param {{home: string, ledger: string, commit: string, expect: string}} round - 这一轮的参数。
 * @param {(command: string) => void} [starter] - 起 worker 的方式，测试注入假的。
 * @returns {void}
 */
function restartApp(round, starter = spawnWorkerOutsideTree) {
  starter(workerCommand(round))
}

/**
 * worker 的命令行。期望的构建戳由调用方算好传进来——裁判和 worker 都不自己算，
 * 算的人只有一个：仓库自己的 build-stamp.js。
 * @param {{home: string, ledger: string, commit: string, expect: string}} round - 这一轮的参数。
 * @returns {string} 一条可直接交给 WMI 的命令行。
 */
function workerCommand(round) {
  const worker = path.join(REPO_ROOT, 'scripts', 'restart-host.mjs')
  return [
    `"${process.execPath}"`, `"${worker}"`,
    '--expect', round.expect,
    '--ledger', `"${round.ledger}"`,
    '--home', `"${round.home}"`,
    '--commit', round.commit,
  ].join(' ')
}

/**
 * 把 worker 起到宿主进程树之外。两条路都由 Windows 服务承载（WMI 提供程序主机 /
 * 计划任务服务），都不在调用方的进程树里，所以裁判随后被 taskkill 收掉时它们活着。
 *
 * WMI 优先：不用注册、不用清理。schtasks 兜底：要建一个一次性任务，worker 结束时会删。
 * @param {string} command - worker 的命令行。
 * @param {(file: string, args: string[], options?: object) => unknown} [spawn] - 执行器，测试注入假的。
 * @returns {'wmi' | 'schtasks' | 'none'} 走通了哪条路。
 */
function spawnWorkerOutsideTree(command, spawn = execFileSync) {
  // 单引号里出现单引号要翻倍，否则 PowerShell 会把命令行截断。
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'}; Write-Output $r.ReturnValue`
  try {
    const out = String(spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim()
    if (out === '0') return 'wmi'
  } catch {
    // WMI 不可用（服务关着、被策略禁掉）：落到 schtasks。
  }
  try {
    spawn('schtasks', ['/create', '/tn', TASK_NAME, '/tr', command, '/sc', 'once', '/st', '00:00', '/f'], { stdio: 'ignore' })
    spawn('schtasks', ['/run', '/tn', TASK_NAME], { stdio: 'ignore' })
    return 'schtasks'
  } catch {
    return 'none'
  }
}

/**
 * 主入口。只有作为入口文件被直接跑时才执行——被测试 import 时不出手，
 * 这样测试能拿到里面的判定函数而不触发一次真的判定。
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { home, ledger, armed } = context(options)

  if (options.action === 'status') {
    const entries = readLedger(ledger)
    if (entries.length === 0) { console.log('the ledger is empty'); return }
    for (const entry of entries.slice(-8)) {
      const sha = typeof entry.commit === 'string' ? entry.commit.slice(0, 7) : '-'
      const mark = entry.ok === undefined ? '' : entry.ok ? 'ok  ' : 'FAIL'
      console.log(`${entry.at}  ${entry.kind.padEnd(7)} ${sha}  ${mark} ${entry.detail ?? ''}`)
    }
    return
  }

  if (options.action === 'arm') {
    const root = options.repoRoot ?? REPO_ROOT
    const commit = options.commit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    appendLedger(ledger, { kind: 'arm', commit, since: new Date().toISOString() })
    console.log(`armed ${commit.slice(0, 7)}; the judge will only clear a restart once the deployed copy matches it byte for byte`)
    return
  }

  if (armed === undefined) {
    console.log('not ok: nothing is armed — run "arm --commit <sha>" first')
    process.exitCode = 1
    return
  }

  if (options.action === 'judge') {
    const result = await runJudge(options, home, ledger, armed)
    console.log(`${result.ok ? 'ok' : 'not ok'}: ${result.detail}`)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.action === 'verify') {
    const result = await runVerify(options, home, ledger, armed)
    console.log(`${result.ok ? 'ok' : 'not ok'}: ${result.detail}`)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.action === 'live') {
    // 不重启的那条路：只改了判断核时，守卫自己会换上磁盘上那份并自报哈希。
    const result = await runLive(options, home, ledger, armed)
    console.log(`${result.ok ? 'ok' : 'not ok'}: ${result.detail}`)
    if (!result.ok) process.exitCode = 1
    return
  }

  if (options.action === 'watch') {
    console.log('watching the ledger; every new arm that matches the deployed copy runs the whole round by itself')
    for (;;) {
      const pending = pendingArm(readLedger(ledger))
      if (pending === undefined) {
        await sleep(POLL_MS)
        continue
      }
      const result = await runAll(options, home, ledger, pending)
      console.log(`${new Date().toISOString()}  ${result.ok ? 'ok  ' : 'FAIL'} ${pending.commit.slice(0, 7)}: ${result.detail}`)
      await sleep(POLL_MS)
    }
  }

  // all（默认）：全自动的一轮。判定不过就绝不动手；判定过了，重启与核对都归它。
  const result = await runAll(options, home, ledger, armed)
  console.log(`${result.ok ? 'ok' : 'not ok'}: ${result.detail}`)
  if (!result.ok) process.exitCode = 1
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) await main()

export {
  appendLedger, coreHashOf, deployedDir, deployedHash, dshHome, expectedHash, gitList, gitShow, hostLog, judge,
  ledgerPath, messageOf, parseArgs, pendingArm, readLedger, restartApp, runAll, runJudge, runLive,
  runVerify, spawnWorkerOutsideTree, waitForHost, waitForLiveCore, workerCommand,
}
