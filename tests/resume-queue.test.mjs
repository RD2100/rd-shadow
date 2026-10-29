/**
 * 钉住续接队列的全部性质。
 *
 * 这条路要成立，靠的是四件事：入队记录读得回来（乱行、缺文件都不炸）；消息 id
 * 由内容确定性算出（同一条记录在任何一次重启后都是同一个 id，重复投递可识别）；
 * 投出去（或判定终判丢弃）后那一行真的消失；失败只有「丢」和「再试」两种归类，
 * 且分得清「会话不在了」和「宿主还没起来」。四条都在下面被直接断言，用的都是
 * 临时目录，不碰 checkout，也不起进程。
 *
 * 用法: node tests/resume-queue.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const {
  appendResumeEntry,
  buildResumeMessage,
  classifyResumeError,
  dropResumeEntry,
  makeResumeEntry,
  readResumeQueue,
  resumeErrorMessage,
  resumeQueuePath,
  writeResumeQueue,
} = await import(pathToFileURL(path.join(ROOT, 'lib', 'resume-queue.js')).href)

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

/** @returns {string} a fresh scratch root. */
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'shadow-resume-queue-'))
  roots.push(root)
  return root
}

// 1. 路径：队列与裁判的账本同目录，两边才找得到同一份。
{
  const home = scratch()
  const file = resumeQueuePath(home)
  check('the queue lives beside the ledger',
    file === path.join(home, '.shadow-verify', 'resume-queue.jsonl'), file)
}

// 2. 没有队列是常态（没重启过就没有），读返回空而不是抛错。
{
  const file = resumeQueuePath(scratch())
  check('a missing queue reads as empty', readResumeQueue(file).length === 0)
}

// 3. 追加 → 读回，顺序保持；半条坏行被跳过，且不影响好行。
{
  const file = resumeQueuePath(scratch())
  const first = makeResumeEntry({ sessionId: 'session-a', text: '第一句', at: '2026-10-30T01:00:00.000Z' })
  const second = makeResumeEntry({ sessionId: 'session-b', text: '第二句', at: '2026-10-30T02:00:00.000Z' })
  appendResumeEntry(file, first)
  appendResumeEntry(file, second)
  const read = readResumeQueue(file)
  check('entries round-trip in order',
    read.length === 2 && read[0].sessionId === 'session-a' && read[1].sessionId === 'session-b')

  // 一行被写坏（半条 JSON）：好行照常读得回来。
  const broken = `${readFileSync(file, 'utf8')}{"sessionId": "half"\n`
  writeFileSync(file, broken)
  check('a torn line is skipped, the good lines survive', readResumeQueue(file).length === 2)
}

// 4. 消息 id 是内容算出来的：同样的事实永远同一个 id（重复投递因此可识别），
// 任何一环不同就不同。
{
  const facts = { sessionId: 'session-a', text: '同一句话', at: '2026-10-30T01:00:00.000Z' }
  const one = makeResumeEntry(facts)
  const two = makeResumeEntry({ ...facts })
  const otherText = makeResumeEntry({ ...facts, text: '另一句话' })
  const otherAt = makeResumeEntry({ ...facts, at: '2026-10-30T03:00:00.000Z' })
  const otherSession = makeResumeEntry({ ...facts, sessionId: 'session-b' })
  check('the same facts give the same id', one.messageId === two.messageId)
  check('the id is prefixed so the log names its origin', one.messageId.startsWith('resume-'), one.messageId)
  check('different text gives a different id', one.messageId !== otherText.messageId)
  check('a different round gives a different id', one.messageId !== otherAt.messageId)
  check('a different session gives a different id', one.messageId !== otherSession.messageId)
  check('the entry is frozen', Object.isFrozen(one))
}

// 5. 缺 sessionId 或 text 直接抛：无声造出一条投不出去的记录比报错糟得多。
{
  let refused = 0
  for (const facts of [{ text: 'x' }, { sessionId: 's' }, {}]) {
    try { makeResumeEntry(facts) } catch { refused += 1 }
  }
  check('an entry without its facts is refused', refused === 3, String(refused))
}

// 6. 投递消息的形状与影子派发逐字一致：role user、一个 text block、source 记明
// 是谁发的。发送者就是目标会话自己——自续不是伪装成别人发的话。
{
  const entry = makeResumeEntry({ sessionId: 'session-a', text: '接着聊', at: '2026-10-30T01:00:00.000Z' })
  const message = buildResumeMessage(entry)
  check('the message is a user message carrying the text',
    message.role === 'user' && message.id === entry.messageId
    && message.content.length === 1 && message.content[0].type === 'text' && message.content[0].text === '接着聊')
  check('the source records the sender', message.source.kind === 'agent-message'
    && message.source.form === 'relay' && message.source.senderSessionId === 'session-a')
  check('the message is frozen', Object.isFrozen(message) && Object.isFrozen(message.content))
}

// 7. 投出去（或终判丢弃）后那一行消失，别的行不动；队列不存在时丢弃是空操作。
{
  const file = resumeQueuePath(scratch())
  const keep = makeResumeEntry({ sessionId: 'session-a', text: '留着', at: '2026-10-30T01:00:00.000Z' })
  const gone = makeResumeEntry({ sessionId: 'session-b', text: '投完了', at: '2026-10-30T02:00:00.000Z' })
  appendResumeEntry(file, keep)
  appendResumeEntry(file, gone)
  dropResumeEntry(file, gone)
  const after = readResumeQueue(file)
  check('a delivered entry is gone and the others stay',
    after.length === 1 && after[0].messageId === keep.messageId)
  dropResumeEntry(file, keep)
  check('the last entry leaves an empty queue', readResumeQueue(file).length === 0)

  const missing = resumeQueuePath(scratch())
  dropResumeEntry(missing, gone)
  check('dropping from a missing queue is a no-op', !existsSync(missing))
}

// 8. 整份写回用临时文件 + 改名：读到半行 JSON 比读不到更糟。
{
  const file = resumeQueuePath(scratch())
  const entry = makeResumeEntry({ sessionId: 'session-a', text: '写回', at: '2026-10-30T01:00:00.000Z' })
  writeResumeQueue(file, [entry])
  check('a written queue reads back exactly', readResumeQueue(file).length === 1 && readResumeQueue(file)[0].text === '写回')
  writeResumeQueue(file, [])
  check('writing an empty queue clears it', existsSync(file) && readResumeQueue(file).length === 0)
  check('no temp file is left behind',
    readdirSync(path.dirname(file)).every((name) => !name.endsWith('.tmp')), readdirSync(path.dirname(file)).join(','))
}

// 9. 失败归类：会话不在了、归子代理路由管——终判，丢；写句柄还被占着、
// 网关抽风、没见过的码——再试。宁可多等几轮，不可把还能投出去的当成废纸。
{
  const terminal = [
    { code: 'session/not-found' },
    { code: 'session/agent-busy' },
  ]
  for (const error of terminal) {
    check(`${String(error.code)} is a terminal drop`, classifyResumeError(error) === 'drop')
  }
  const retryable = [
    { code: 'session/writer-held' },
    { code: 'gateway/internal' },
    { code: 'something-nobody-has-seen' },
    undefined,
    new Error('a bare throw carries no code'),
  ]
  for (const error of retryable) {
    check(`${resumeErrorMessage(error)} is retryable`, classifyResumeError(error) === 'retry')
  }
}

// 10. 错误文字：Error 取 message，别的取字符串——日志要能读。
{
  check('an Error reports its message', resumeErrorMessage(new Error('坏了')) === '坏了')
  check('a bare value reports itself', resumeErrorMessage('字符串') === '字符串')
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

console.log(failures === 0 ? 'resume queue: all checks passed' : `resume queue: ${String(failures)} failed`)
process.exitCode = failures === 0 ? 0 : 1
