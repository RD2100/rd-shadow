/**
 * 重启后续接队列。
 *
 * 裁判轮杀宿主时，被斩的那一轮对话就此断了：会话本身跨重启原样续上（历史在
 * `session.v4.jsonl.zstd`），但「自动继续」死了，得有人再发一句消息才接得上。
 * 自我迭代的闭环就断在这一步——每改一次宿主半边，都要人戳一下。
 *
 * 于是把「重启前没说完的话」写进队列：裁判杀之前入队，宿主重启后由本插件的
 * 宿主半边（`lib/index.js`）读队、投递、踢醒。投递走的是宿主自己的会话入口
 * （`sessionController.resolveAgent` + `agent.send(..., 'next-turn', true)`），
 * 和影子派发同一条路，不需要 HTTP、不需要令牌、不在宿主进程树之外猜地址。
 *
 * 这个模块只有纯逻辑：队列文件的读写、入队记录的构造、投递消息的构造、
 * 投递失败的归类。宿主半边只负责把它们接到服务上。裁判（`scripts/`）和插件
 * （`lib/`）共用这一份，两边对「一条入队记录长什么样」不会有分歧。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** 队列文件放在 `.shadow-verify` 里，和裁判的账本（ledger）同目录。 */
const QUEUE_FILE = 'resume-queue.jsonl'

/** 前缀让日志里一眼认出这条消息 id 来自续接队列。 */
const MESSAGE_ID_PREFIX = 'resume-'

/**
 * `sessionController.resolveAgent` 失败时返回的错误码里，这两种是终判：
 * 会话不在了，或者这身份归子代理路由管——再等也等不回来，记账后丢掉。
 * 其余（`session/writer-held`、`gateway/internal`、没见过的码）都当可重试：
 * 宿主刚起来时写句柄还没归位是常态，下一轮再来。
 */
const TERMINAL_CODES = new Set(['session/not-found', 'session/agent-busy'])

/** 一条入队记录的最小形状；缺字段的行在读取时被跳过。 */
function isEntry(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.text === 'string' && value.text.length > 0
    && typeof value.at === 'string' && value.at.length > 0
    && typeof value.messageId === 'string' && value.messageId.length > 0
}

/**
 * 队列文件的路径。
 * @param home - DSH_HOME；与裁判、插件用同一个家目录，队列才对得上。
 * @returns 队列文件的绝对路径。
 */
export function resumeQueuePath(home) {
  return path.join(home, '.shadow-verify', QUEUE_FILE)
}

/**
 * 读出全部待投递的入队记录。
 *
 * 文件不存在是常态（没重启过就没有队列），返回空数组而不是抛错；坏行跳过——
 * 它会在下一次落盘（投递成功或丢弃）时被自然清掉。
 * @param file - 队列文件路径。
 * @returns 待投递记录，按入队顺序。
 */
export function readResumeQueue(file) {
  if (!existsSync(file)) return []
  const entries = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (isEntry(entry)) entries.push(entry)
    } catch {
      // 坏行：半条 JSON 没有任何投递价值，跳过即可。
    }
  }
  return entries
}

/**
 * 构造一条入队记录。
 *
 * 消息 id 由内容确定性算出：同一条记录在任何一次重启后都得到同一个 id，
 * 重复投递因此可被识别（日志、会话历史里都对得上）。`at` 也参与哈希，
 * 所以两轮不同时间的入队即使文本相同也是两条不同的消息。
 * @param facts - 目标会话、要投递的文本、入队时刻（ISO 字符串）。
 * @returns 冻结的记录。
 */
export function makeResumeEntry({ sessionId, text, at }) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('makeResumeEntry: sessionId is required')
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('makeResumeEntry: text is required')
  }
  const stamp = typeof at === 'string' && at.length > 0 ? at : new Date().toISOString()
  const messageId = MESSAGE_ID_PREFIX + createHash('sha256')
    .update(`${sessionId}\n${text}\n${stamp}`, 'utf8')
    .digest('hex')
    .slice(0, 24)
  return Object.freeze({ sessionId, text, at: stamp, messageId })
}

/**
 * 入队：追加一行。追加就够，队列只有裁判一个写者，且它写在重启之前。
 * @param file - 队列文件路径。
 * @param entry - {@link makeResumeEntry} 造出的记录。
 * @returns nothing.
 */
export function appendResumeEntry(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * 把整份队列写回磁盘（投递或丢弃后调用）。临时文件 + 改名，避免半行 JSON。
 * @param file - 队列文件路径。
 * @param entries - 写回后的全部记录。
 * @returns nothing.
 */
export function writeResumeQueue(file, entries) {
  mkdirSync(path.dirname(file), { recursive: true })
  const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const temp = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temp, body, 'utf8')
  renameSync(temp, file)
}

/**
 * 投递（或判定终判丢弃）后，把这一条从队列里去掉。
 * @param file - 队列文件路径。
 * @param entry - 要去掉的记录；按 messageId 匹配。
 * @returns nothing.
 */
export function dropResumeEntry(file, entry) {
  if (!existsSync(file)) return
  const kept = readResumeQueue(file).filter((item) => item.messageId !== entry.messageId)
  writeResumeQueue(file, kept)
}

/**
 * 造出要投递的那条用户消息。
 *
 * 形状与影子派发逐字一致（`buildRelayMessage`）：role `user`、一个 text block、
 * source 记明来源。发送者就是目标会话自己——是它跑的裁判、也是它要被接上，
 * 自续不是伪装成别人发的话。
 * @param entry - 入队记录。
 * @returns 冻结的 UserMessage，可直接交给 `agent.send`。
 */
export function buildResumeMessage(entry) {
  return Object.freeze({
    id: entry.messageId,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: entry.text })]),
    source: Object.freeze({ kind: 'agent-message', form: 'relay', senderSessionId: entry.sessionId }),
  })
}

/**
 * 判断一次投递失败是该丢还是该再试。
 *
 * 终判码见 {@link TERMINAL_CODES}；没见过的码按可重试算——宁可多等几轮，
 * 不可把一条还能投出去的续接消息当成废纸扔了。
 * @param error - `resolveAgent` 返回的 error，或抛出的值。
 * @returns `'drop'` 或 `'retry'`。
 */
export function classifyResumeError(error) {
  const code = error?.code
  return typeof code === 'string' && TERMINAL_CODES.has(code) ? 'drop' : 'retry'
}

/**
 * 读错误的文字，用于日志。
 * @param error - 任意被捕获的值。
 * @returns 一行可读文本。
 */
export function resumeErrorMessage(error) {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}
