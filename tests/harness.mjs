/**
 * The one test harness every suite uses.
 *
 * Contract (docs/test-cases.md §1):
 * - Every case has an id `TC-<AREA>-<NNN>`; ids are unique across the repo and
 *   are the key that links docs/test-cases.md to code. tests/tc-index.mjs reads
 *   them from source text, so pass the id as a string literal.
 * - `check(id, name, fn)` runs `fn` (sync or async). A throw is a failure.
 * - `todo(id, name)` records a specified-but-unimplemented case. It never fails
 *   the run unless SHADOW_STRICT_TODO=1 (use that in release checks).
 * - `done()` awaits every pending check, prints one summary line, and sets
 *   `process.exitCode = 1` on any failure. Call it exactly once, last.
 */

/** Allowed id shape. */
export const ID_PATTERN = /^TC-[A-Z][A-Z0-9]*-\d{3}$/

/**
 * Create one suite.
 * @param title - printed on the summary line, e.g. `dispatch-core`.
 * @returns `{check, todo, done}`.
 */
export function suite(title) {
  const ids = new Set()
  const pending = []
  const todos = []
  let passed = 0
  let failed = 0

  /** Reject a malformed or duplicate id: traceability depends on both. */
  const claim = (id) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`${title}: invalid test id ${JSON.stringify(id)}`)
    if (ids.has(id)) throw new Error(`${title}: duplicate test id ${id}`)
    ids.add(id)
  }

  /** Record one outcome. */
  const settle = (id, name, error) => {
    if (error === undefined) {
      passed += 1
      if (process.env.SHADOW_VERBOSE === '1') console.log(`ok   ${id} ${name}`)
      return
    }
    failed += 1
    console.error(`FAIL ${id} ${name}: ${error?.stack ?? error?.message ?? error}`)
  }

  /**
   * Run one case. Returns a promise so `await check(...)` keeps order when a
   * suite needs it; a bare call is also safe because done() awaits it.
   * @param id - the case id.
   * @param name - one-line behavior statement.
   * @param fn - the case body.
   * @returns a promise that settles when the case has been recorded.
   */
  const check = (id, name, fn) => {
    claim(id)
    let result
    try {
      result = fn()
    } catch (error) {
      settle(id, name, error)
      return Promise.resolve()
    }
    if (result !== null && typeof result?.then === 'function') {
      const tracked = Promise.resolve(result).then(() => settle(id, name), (error) => settle(id, name, error))
      pending.push(tracked)
      return tracked
    }
    settle(id, name)
    return Promise.resolve()
  }

  /**
   * Declare a specified case that has no implementation yet.
   * @param id - the case id (its spec lives in docs/test-cases.md).
   * @param name - one-line behavior statement.
   */
  const todo = (id, name) => {
    claim(id)
    todos.push(`${id} ${name}`)
  }

  /** Await pending cases, print the summary, and set the exit code. */
  const done = async () => {
    await Promise.all(pending)
    const strict = process.env.SHADOW_STRICT_TODO === '1'
    for (const line of todos) console.log(`todo ${line}`)
    console.log(`${title}: ${passed} passed, ${failed} failed, ${todos.length} todo`)
    if (failed > 0 || (strict && todos.length > 0)) process.exitCode = 1
  }

  return { check, todo, done }
}
