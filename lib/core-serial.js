/**
 * Per-key operation chains: one key's operations run strictly in order, other
 * keys run independently.
 *
 * Layer: core (pure). Imports: none.
 * Used by op-dispatch.js so two dispatches to the same target never interleave
 * their admission checks and sends (docs/detailed-design.md §4.2 step S).
 */

/**
 * Create one serializer. Each plugin instance owns exactly one.
 * @returns `run(key, operation)` plus `size()` for diagnostics and tests.
 */
export function createSerializer() {
  /** Tail promise per key; settles when the newest operation for that key settles. */
  const chains = new Map()

  /**
   * Run one operation after every earlier operation for the same key.
   * A rejected earlier operation does not block later ones.
   * @param key - the chain the operation belongs to (a target Session id).
   * @param operation - zero-argument async work.
   * @returns the operation's own result or rejection.
   */
  const run = (key, operation) => {
    const prior = chains.get(key) ?? Promise.resolve()
    const next = prior.then(operation, operation)
    chains.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /** @returns how many keys currently hold a chain entry. */
  const size = () => chains.size

  return { run, size }
}
