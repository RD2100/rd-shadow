/**
 * 钉住「改守卫规则不必重启」这一条路的全部性质。
 *
 * 这一条路成立的前提有三：磁盘上那份字节变了，下一次判断就用新的；读坏的那一份
 * 永远替不掉能用的那一份；宿主自报的哈希就是它真正生效的那一份字节。三条都在下面
 * 被直接断言，用的都是临时目录里的假核，不碰 checkout，也不起进程。
 *
 * 用法: node tests/live-core.test.mjs
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIB = path.join(ROOT, 'lib')
const liveCoreUrl = pathToFileURL(path.join(LIB, 'live-core.js')).href
const { createLiveCore } = await import(liveCoreUrl)

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
 * 一个临时目录，里面放一份可改写的核。
 * @returns {{root: string, file: string}} 目录与核文件的路径。
 */
function stage() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shadow-live-core-'))
  roots.push(root)
  const file = path.join(root, 'core.js')
  writeFileSync(file, [
    'export const allow = ["first.example"]',
    'export function judge(host) { return allow.includes(host) ? "pass" : "ask" }',
    '',
  ].join('\n'))
  return { root, file }
}

/** 改写那份核；内容不同，哈希就不同。 */
function rewrite(file, body) {
  writeFileSync(file, body)
}

// 1. 文件没变过，读多少次都是同一份，一次多余的 import 都不发生。
{
  const { file } = stage()
  const initial = { allow: ['first.example'], judge: () => 'pass' }
  const reports = []
  const live = createLiveCore(file, { initial, pollMs: 0, onSwap: (info) => reports.push(info) })
  const first = await live.core()
  const second = await live.core()
  const third = await live.core()
  check('an unchanged file is read once and reused', first === second && second === third)
  check('only the mount is reported for an unchanged file', reports.length === 1 && reports[0].first === true)
  check('the reported hash is the hash of those bytes', live.hash() === (await import('node:crypto')).createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12))
}

// 1b. 第一次读取会重新 import 一遍同样的字节：这是故意的，它证明动态 import 这条路
// 在这个宿主里走得通；走不通时退回宿主那一份，守卫照旧工作。
{
  const { file } = stage()
  const initial = { judge: () => 'host' }
  const reports = []
  const live = createLiveCore(file, { initial, pollMs: 0, onSwap: (info) => reports.push(info) })
  const first = await live.core()
  check('the first read confirms the dynamic path works', first !== initial && typeof first.judge === 'function')
  check('the confirmation is reported as a mount, not a swap', reports.length === 1 && reports[0].first === true)
  check('a second read costs nothing', (await live.core()) === first && reports.length === 1)
}

// 2. 字节变了，下一次判断就用新的——这一条是整条路的地基。
{
  const { file } = stage()
  const swaps = []
  const live = createLiveCore(file, { initial: { judge: () => 'old' }, pollMs: 0, onSwap: (info) => swaps.push(info) })
  await live.core()
  const mounted = live.hash()
  rewrite(file, 'export function judge() { return "new" }\n')
  const after = await live.core()
  check('a changed file is picked up on the next read', typeof after.judge === 'function' && after.judge() === 'new')
  check('the swap is reported once with both hashes', swaps.length === 2 && swaps[1].hash === live.hash() && swaps[1].hash !== swaps[1].previousHash)
  check('the reported hash is the hash of the new bytes', live.hash() === (await import('node:crypto')).createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12))
  check('the mount report precedes the swap report', swaps[0].hash === mounted && swaps[0].first === true)
}

// 3. 读坏不换：语法错误的那一份，永远替不掉正在生效的那一份。
{
  const { file } = stage()
  const initial = { judge: () => 'still-working' }
  const live = createLiveCore(file, { initial, pollMs: 0 })
  const working = await live.core()
  rewrite(file, 'export function judge() { return "broken"\nthis is not javascript\n')
  const after = await live.core()
  check('a syntactically broken file does not replace the working core', after === working && after.judge('first.example') === 'pass')
  check('the failure is recorded rather than swallowed', typeof live.error() === 'string' && live.error().length > 0)
  check('the reported hash still names the working bytes', live.hash().length === 12 && live.hash() !== (await import('node:crypto')).createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12))
}

// 4. 缺导出的那一份同样被拒：换上去就是当场失效，所以这一换直接不算。
{
  const { file } = stage()
  const initial = { inspectEgress: () => ({}), touchesProtected: () => undefined, assignmentsIn: () => new Map() }
  const live = createLiveCore(file, {
    initial,
    pollMs: 0,
    requires: ['inspectEgress', 'touchesProtected', 'assignmentsIn'],
  })
  const working = await live.core()
  rewrite(file, 'export function judge() { return "incomplete" }\n')
  const after = await live.core()
  check('a core missing required exports is refused', after === working)
  check('the refusal names what is missing', /missing/.test(String(live.error())))
}

// 5. 修好之后再换上去：一次失败不是终局。
{
  const { file } = stage()
  const initial = { judge: () => 'old' }
  const live = createLiveCore(file, { initial, pollMs: 0 })
  const working = await live.core()
  rewrite(file, 'export function judge() { return "broken"\n')
  await live.core()
  check('the broken attempt left the working core in place', (await live.core()) === working)
  rewrite(file, 'export function judge() { return "repaired" }\n')
  const repaired = await live.core()
  check('a later good file is picked up after a failed one', repaired !== working && repaired.judge() === 'repaired')
  check('the error clears on a successful swap', live.error() === null)
}

// 6. 文件读不到时保留当前那一份，并把原因记下来。
{
  const { root, file } = stage()
  const initial = { judge: () => 'old' }
  const live = createLiveCore(file, { initial, pollMs: 0 })
  const working = await live.core()
  rmSync(file)
  const after = await live.core()
  check('an unreadable file keeps the current core', after === working)
  check('the unreadable file is reported', /could not be read/.test(String(live.error())))
  rmSync(root, { recursive: true, force: true })
}

// 7. 并发共用一次加载：两个判断同时发现文件变了，只 import 一次，拿到同一实例。
{
  const { file } = stage()
  const initial = { judge: () => 'old' }
  const live = createLiveCore(file, { initial, pollMs: 0 })
  await live.core()
  rewrite(file, 'export function judge() { return "concurrent" }\n')
  const [a, b] = await Promise.all([live.core(), live.core()])
  check('concurrent reads share one load', a === b && a.judge() === 'concurrent')
}

// 8. 内容寻址，不是「最后一次成功」：换出去的字节，改回原样就还是原来那份内容。
{
  const { file } = stage()
  const original = readFileSync(path.join(LIB, 'dispatch-core.js'))
  writeFileSync(file, original)
  const initial = { judge: () => 'host' }
  const live = createLiveCore(file, { initial, pollMs: 0 })
  const atStart = await live.core()
  check('a file identical to the mounted bytes loads that content', atStart !== initial && typeof atStart.inspectEgress === 'function')
  rewrite(file, 'export function judge() { return "diverged" }\n')
  check('a diverged file is picked up', (await live.core()).judge() === 'diverged')
  writeFileSync(file, original)
  check('reverting the bytes restores the mounted content', typeof (await live.core()).inspectEgress === 'function')
}
// 9. 轮询：不等工具调用，同步之后几秒内就换；stop() 之后轮询不再自己动手。
{
  const { file } = stage()
  const swaps = []
  const live = createLiveCore(file, { initial: { judge: () => 'old' }, pollMs: 20, onSwap: (info) => swaps.push(info) })
  await live.core()
  const beforePoll = swaps.length
  rewrite(file, 'export function judge() { return "polled" }\n')
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline && swaps.length === beforePoll) {
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  check('the poll picks the change up without any call of its own', swaps.length === beforePoll + 1)
  live.stop()
  const afterStop = swaps.length
  rewrite(file, 'export function judge() { return "after-stop" }\n')
  await new Promise((resolve) => { setTimeout(resolve, 120) })
  check('stop() ends the polling', swaps.length === afterStop)
  live.stop()
  check('stop() is idempotent', true)
}

// 10. 真核走这条路也成立：部署副本里的 dispatch-core.js 就是热换的对象，
//     它的导出名必须在 requires 里一个不少——否则上线第一次热换就会被拒。
{
  const core = await import(pathToFileURL(path.join(LIB, 'dispatch-core.js')).href)
  for (const name of ['inspectEgress', 'touchesProtected', 'assignmentsIn']) {
    check(`the real core exports ${name}`, core[name] !== undefined)
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'shadow-live-core-'))
  roots.push(scratch)
  const staged = path.join(scratch, 'dispatch-core.js')
  cpSync(path.join(LIB, 'dispatch-core.js'), staged)
  const live = createLiveCore(staged, {
    initial: core,
    pollMs: 0,
    requires: ['inspectEgress', 'touchesProtected', 'assignmentsIn'],
  })
  const loaded = await live.core()
  check('the real core loads through the live path', loaded !== core && typeof loaded.inspectEgress === 'function')
  check('the live path reports a hash for the real core', /^[0-9a-f]{12}$/.test(live.hash()))
  // 真核改一个字节，热换必须跟上——这一条是上线后真正会发生的事。
  writeFileSync(staged, `${readFileSync(staged, 'utf8')}\n// one byte of difference\n`)
  check('a one-byte change to the real core is picked up', (await live.core()) !== loaded)
}

// Remove the scratch roots and nothing else: each one is a direct child of the
// temp dir, and a test that cleaned up by guessing would be one typo away from
// deleting something it does not own.
for (const root of roots) {
  if (path.dirname(root) !== os.tmpdir()) {
    console.error(`FAIL refusing to clean outside the temp dir: ${root}`)
    failures += 1
    continue
  }
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'live core: all checks passed' : `live core: ${String(failures)} failed`)
process.exitCode = failures === 0 ? 0 : 1
