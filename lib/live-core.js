/**
 * 让纯判断核可以不重启就换掉。
 *
 * 插件和正在跑的对话住在同一个宿主进程里，所以「改一行守卫代码」过去意味着
 * 「杀宿主、重启、打断当前这一轮」。可绝大多数改动只动 ./dispatch-core.js——
 * 纯判断核，无 host 依赖——而宿主半边（注册、工具、事件监听）一个字都没变。
 * 变的那一半既然能单独读进来，就没有理由为它杀整个进程。
 *
 * 做法：每次出网判断（外加一个松开引用的轮询）都看一眼磁盘上那份核，字节变了就
 * 带着一个新的 query 重新 import。ESM 的模块缓存按 URL 的 query 区分，所以
 * `./dispatch-core.js?v=7` 是一个新模块，旧实例原地不动——Node 24 实测过，
 * 性质钉在 tests/live-core.test.mjs。
 *
 * 三条安全性质，都是测试钉住的：
 * 1. **读坏不换**：新核 import 抛错（语法错误）或缺少 requires 里的导出名，就保留
 *    当前这份并记下原因。一个写坏的文件永远不能把一个能用的核替掉。
 * 2. **看不见半写**：sync.mjs 用「写临时文件再 rename」落盘，rename 是原子的，
 *    轮询因此永远读不到写了一半的字节。
 * 3. **判断失败即拒绝**：核换上去之后在某一次调用里抛错，由 tools.js 既有的
 *    try/catch 以「出网检查本身失败」拒绝该次调用——一个 bug 不会变成一个洞。
 *
 * 这个模块本身不 import 任何 host 东西，也不 import 那个核：初始那一份由调用方
 * （宿主静态 import 的命名空间）传进来，所以启动路径和以前完全一样，热换只是
 * 在此之上加的一条旁路。
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 默认轮询间隔：同步之后几秒内就换，不等一次工具调用。 */
const DEFAULT_POLL_MS = 5_000

/**
 * 磁盘上那一份核的指纹。内容寻址——mtime 只作陪衬，因为两次改写可能落在同一毫秒。
 * @param {URL} file - 核的文件 URL。
 * @returns {{hash: string, size: number} | null} 指纹；读不到时为 null。
 */
function probe(file) {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return null
    const bytes = readFileSync(file)
    return { hash: createHash('sha256').update(bytes).digest('hex').slice(0, 12), size: stat.size }
  } catch {
    return null
  }
}

/**
 * 造一个可热换的核。
 * @param {URL | string} target - 核的文件 URL 或路径。
 * @param {object} [options] - 选项。
 * @param {object} [options.initial] - 宿主静态 import 进来的那一份，启动时的当前值。
 * @param {string[]} [options.requires] - 新核必须带上的导出名；缺一个就拒绝这次热换。
 * @param {(info: {hash: string, previousHash: string}) => void} [options.onSwap] - 换成功后的回调，宿主在这里记一行日志。
 * @param {number} [options.pollMs] - 轮询间隔毫秒；0 表示不轮询，只在下一次调用时看。
 * @returns {{core: () => Promise<object | undefined>, hash: () => string, error: () => string | null, stop: () => void}} 读取入口。
 */
export function createLiveCore(target, options = {}) {
  const file = target instanceof URL ? target : pathToFileURL(target)
  const href = file.href
  const initial = options.initial
  const requires = Array.isArray(options.requires) ? options.requires : []
  const onSwap = typeof options.onSwap === 'function' ? options.onSwap : () => {}
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(0, Number(options.pollMs)) : DEFAULT_POLL_MS

  /** 当前生效的核。启动时就是宿主加载的那一份，所以没有任何行为变化。 */
  let current = initial
  /**
   * 当前生效的核对应的字节指纹，用来判断磁盘上那份是不是还是它。
   *
   * 故意从空串开始：挂载那一刻磁盘上的字节和宿主刚加载的字节之间有一个谁也说不出
   * 长短的窗口，把挂载时读到的哈希当成「已加载」，那个窗口里落下的改动就永远
   * 跟不上了。从空串开始意味着第一次读取一定重新 import 一次——同一个字节，多花
   * 几毫秒，换来动态 import 这条路真的被走过一遍：走不通就退回归宿载的那一份。
   */
  let hash = ''
  /** 最近一次热换失败的原因；成功时清空。 */
  let error = null
  /** 正在进行的加载，让并发调用共用一次 import。 */
  let loading = null
  /** query 序号，保证每一次重新 import 都是一个新模块。 */
  let serial = 0
  let timer = null

  /**
   * 装上新的核并记一笔。
   * @param {object} mod - 刚 import 进来的命名空间。
   * @param {{hash: string}} seen - 磁盘上那份的指纹。
   * @returns {object} 新的当前核。
   */
  const settle = (mod, seen) => {
    const previousHash = hash
    const first = previousHash === ''
    current = mod
    hash = seen.hash
    error = null
    // 第一次加载不是「换」，是「认」：它证明动态 import 这条路在这个宿主里走得通，
    // 顺带给出挂载时生效的是哪一份字节。走不通时 previousHash 仍是空串，不会误报。
    onSwap({ hash: seen.hash, previousHash, first })
    return mod
  }

  /**
   * 把磁盘上那份读进来。读坏就地保留当前这份——见文件头第 1 条。
   * @param {{hash: string}} seen - 磁盘上那份的指纹。
   * @returns {Promise<object | undefined>} 换上去的新核，或保留的旧核。
   */
  const load = (seen) => {
    if (loading !== null) return loading
    serial += 1
    const attempt = (async () => {
      let mod
      try {
        // query 是缓存穿透的唯一机关：同一个路径、不同的 query，ESM 当成两个模块。
        mod = await import(`${href}?v=${String(serial)}`)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        return current
      }
      const missing = requires.filter((name) => mod?.[name] === undefined)
      if (missing.length > 0) {
        // 缺导出的核换上去就是当场失效，所以这一换直接被拒。
        error = `the new core is missing ${missing.join(', ')}`
        return current
      }
      return settle(mod, seen)
    })().finally(() => { loading = null })
    loading = attempt
    return attempt
  }

  /**
   * 当前生效的核；磁盘上那份变了就先换再返回。
   * @returns {Promise<object | undefined>} 核的命名空间；启动就没加载上时是 undefined。
   */
  const core = async () => {
    const seen = probe(file)
    // 读不到磁盘：保留当前这份。第一次调用就读不到时，调用方看到的是启动那一份。
    if (seen === null) {
      if (error === null) error = 'the core file could not be read'
      return current
    }
    if (seen.hash === hash) return current
    return load(seen)
  }

  /**
   * 停掉轮询。插件 fiber 被销毁时调用；不调用也不会拖住进程退出——定时器是 unref 的。
   * @returns {void}
   */
  const stop = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  if (pollMs > 0) {
    timer = setInterval(() => { void core() }, pollMs)
    // 不拖住宿主退出：这个定时器只是让热换早几秒发生，不该成为进程不退的理由。
    timer.unref?.()
  }

  return { core, hash: () => hash, error: () => error, stop }
}
