/**
 * Unit checks for the small pure helpers the op-* modules own: the per-target
 * serializer, page-limit clamps, title collection, and rejection receipts.
 * Runs under plain Node; op-dispatch.js imports nothing from the host.
 */
import assert from 'node:assert/strict'
import { suite } from './harness.mjs'
import { createSerializer } from '../lib/core-serial.js'
import { inspectPageLimit } from '../lib/op-inspect.js'
import { collectTitles, targetsPageLimit } from '../lib/op-targets.js'
import { reject } from '../lib/op-dispatch.js'
import { INSPECT_PAGE_DEFAULT, INSPECT_PAGE_MAX, TARGETS_PAGE_DEFAULT, TARGETS_PAGE_MAX } from '../lib/core-contract.js'

const { check, todo, done } = suite('ops')

/** A promise plus its resolver. */
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

await check('TC-OPS-001', 'operations on one key run strictly in order', async () => {
  const serial = createSerializer()
  const order = []
  const gate = deferred()
  const first = serial.run('t', async () => { await gate.promise; order.push('first') })
  const second = serial.run('t', async () => { order.push('second') })
  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
})

await check('TC-OPS-002', 'a rejected operation does not block the next one on its key', async () => {
  const serial = createSerializer()
  const failed = serial.run('t', async () => { throw new Error('boom') })
  const next = serial.run('t', async () => 'ran')
  await assert.rejects(failed, /boom/)
  assert.equal(await next, 'ran')
})

await check('TC-OPS-003', 'different keys do not wait on each other', async () => {
  const serial = createSerializer()
  const gate = deferred()
  const blocked = serial.run('a', () => gate.promise)
  assert.equal(await serial.run('b', async () => 'b done'), 'b done')
  gate.resolve()
  await blocked
})

await check('TC-OPS-004', 'settled chains are pruned without deleting a newer tail (TASK-05)', async () => {
  const serial = createSerializer()
  assert.equal(await serial.run('t', async () => 42), 42)
  await new Promise(setImmediate)
  assert.equal(serial.size(), 0)
  const gate = deferred()
  const first = serial.run('t', async () => 'first')
  const second = serial.run('t', () => gate.promise)
  await first
  await new Promise(setImmediate)
  assert.equal(serial.size(), 1)
  gate.resolve('second')
  assert.equal(await second, 'second')
  await assert.rejects(serial.run('bad', () => { throw new Error('boom') }), /boom/)
  await new Promise(setImmediate)
  assert.equal(serial.size(), 0)
})

check('TC-OPS-005', 'inspection page size defaults, truncates, and clamps', () => {
  assert.equal(inspectPageLimit(undefined), INSPECT_PAGE_DEFAULT)
  assert.equal(inspectPageLimit(0), 1)
  assert.equal(inspectPageLimit(-5), 1)
  assert.equal(inspectPageLimit(7.9), 7)
  assert.equal(inspectPageLimit(10_000), INSPECT_PAGE_MAX)
})

check('TC-OPS-006', 'catalog page size defaults, truncates, and clamps', () => {
  assert.equal(targetsPageLimit(undefined), TARGETS_PAGE_DEFAULT)
  assert.equal(targetsPageLimit(0), 1)
  assert.equal(targetsPageLimit(3.2), 3)
  assert.equal(targetsPageLimit(10_000), TARGETS_PAGE_MAX)
})

check('TC-OPS-007', 'title collection keeps fulfilled titles and skips rejected or malformed entries', () => {
  const titles = collectTitles([
    { sessionId: 'a', status: 'fulfilled', value: { session: { id: 'a' }, title: { title: 'A' } } },
    { sessionId: 'b', status: 'rejected', reason: new Error('x') },
    { sessionId: 'c', status: 'fulfilled', value: { session: { id: 'c' }, title: { title: '' } } },
    { sessionId: 'd', status: 'fulfilled', value: { title: { title: 'no header' } } },
    null,
  ])
  assert.deepEqual([...titles], [['a', 'A']])
})

check('TC-OPS-008', 'a rejection receipt carries the code and its detail', () => {
  assert.deepEqual(reject('busy'), { status: 'rejected', selected: null, evidence: null, reason: 'busy' })
  assert.equal(reject('busy', 'the target is running').reason, 'busy (the target is running)')
})

await done()
